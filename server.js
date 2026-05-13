require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const axios = require('axios');

const nodemailer = require('nodemailer');

// Email Transporter Configuration
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});
const lastBotMessages = new Map();
const processedMessageIds = new Set(); // To prevent processing retried webhooks
const inFlightRequests = new Set(); // To prevent concurrent processing for same phone
// clientId_phone -> lastMessageText

// Configure storage for uploads
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const { clientId } = req.params;
        const dir = path.join(__dirname, 'uploads', clientId || 'general');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});
const upload = multer({ storage });
const logoUpload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => {
            const dir = path.join(__dirname, 'uploads', 'logos');
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            cb(null, dir);
        },
        filename: (req, file, cb) => {
            cb(null, `logo-${req.params.id}-${Date.now()}${path.extname(file.originalname)}`);
        }
    })
});

const app = express();
// Priority: process.env.PORT -> .env PORT -> 8080
const PORT = process.env.PORT || 8080;

// Super Defensive Environment Variable Check (Handling API/APT confusion)
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_APT_KEY;
const INTERAKT_KEY = process.env.INTERAKT_API_KEY || process.env.INTERAKT_APT_KEY;

const { OpenAI } = require('openai');
const openai = OPENAI_KEY ? new OpenAI({
    apiKey: OPENAI_KEY,
    timeout: 30 * 1000 // 30 seconds timeout to prevent hanging
}) : null;

console.log(`🤖 [AI STATUS] OpenAI Initialized: ${!!openai} (${process.env.OPENAI_API_KEY ? 'Using OPENAI_API_KEY' : (process.env.OPENAI_APT_KEY ? 'Using OPENAI_APT_KEY' : 'KEY MISSING')})`);

const SimpleRAG = require('./rag');
const rag = new SimpleRAG(openai);
const gcs = require('./gcs');

console.log(`☁️ [GCS STATUS] GCS Active: ${gcs.isGcsActive}`);

// Import database
const { Client, Ticket, Chat, OTP, isLocal } = require('./database');

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    credentials: true
}));
app.options(/.*/, cors());

app.use(express.json());

// Serving Static Files with GCS Fallback logic
app.get('/uploads/logos/:filename', async (req, res) => {
    const { filename } = req.params;
    const localPath = path.join(__dirname, 'uploads', 'logos', filename);

    if (fs.existsSync(localPath)) return res.sendFile(localPath);

    console.log(`🔍 [FALLBACK] Logo ${filename} missing locally. GCS Active: ${gcs.isGcsActive}`);

    if (gcs.isGcsActive) {
        try {
            console.log(`📥 [FALLBACK] Attempting GCS download for logo: ${filename}`);
            await gcs.downloadFromBucket('logos', filename, localPath);
            if (fs.existsSync(localPath)) {
                console.log(`✅ [FALLBACK] Logo ${filename} recovered from GCS.`);
                return res.sendFile(localPath);
            } else {
                console.warn(`⚠️ [FALLBACK] Logo ${filename} not found in GCS bucket.`);
            }
        } catch (e) {
            console.error(`❌ [FALLBACK] Logo recovery failed: ${e.message}`);
        }
    }
    // Final fallback: serve a default blank logo if nothing works
    res.redirect('https://cdn-icons-png.flaticon.com/512/3135/3135715.png');
});

app.get('/uploads/:clientId/:filename', async (req, res) => {
    const { clientId, filename } = req.params;
    const localPath = path.join(__dirname, 'uploads', clientId, filename);

    if (fs.existsSync(localPath)) return res.sendFile(localPath);

    console.log(`🔍 [FALLBACK] File ${filename} missing locally for client ${clientId}. GCS Active: ${gcs.isGcsActive}`);

    if (gcs.isGcsActive) {
        try {
            console.log(`📥 [FALLBACK] Attempting GCS download for client ${clientId} file: ${filename}`);
            await gcs.downloadFromBucket(clientId, filename, localPath);
            if (fs.existsSync(localPath)) {
                console.log(`✅ [FALLBACK] File ${filename} recovered from GCS.`);
                return res.sendFile(localPath);
            } else {
                console.warn(`⚠️ [FALLBACK] File ${filename} not found in GCS bucket for client ${clientId}.`);
            }
        } catch (e) {
            console.error(`❌ [FALLBACK] File recovery failed: ${e.message}`);
        }
    }
    res.status(404).send('Not found');
});

app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// Simple Health Check for Cloud Run
app.get('/', (req, res) => res.send('🚀 Whatsabot Backend is Live!'));
app.get('/health', (req, res) => res.json({ status: 'ok', port: PORT, mode: isLocal ? 'local' : 'live' }));

// --- SYNC LOGIC ---
async function syncKnowledgeBase() {
    console.log('🔄 [RAG] Syncing Knowledge Base...');
    try {
        const clients = await Client.find({});
        const kbRoot = path.join(__dirname, 'knowledge_base');
        if (!fs.existsSync(kbRoot)) fs.mkdirSync(kbRoot, { recursive: true });

        for (const client of clients) {
            const clientFolder = (client._id || client.id).toString();
            const clientKbDir = path.join(kbRoot, clientFolder);

            if (!fs.existsSync(clientKbDir)) fs.mkdirSync(clientKbDir, { recursive: true });

            if (gcs.isGcsActive) {
                const cloudFiles = await gcs.listClientFiles(clientFolder);
                for (const file of cloudFiles) {
                    const localFilePath = path.join(clientKbDir, file);
                    if (!fs.existsSync(localFilePath)) await gcs.downloadFromBucket(clientFolder, file, localFilePath);
                }
            }
        }
        if (openai) await rag.init();
        console.log('✅ [RAG] Knowledge Base Ready.');
    } catch (err) {
        console.error('❌ [RAG] Sync Failed:', err.message);
    }
}

// --- AUTH ROUTES ---
app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    const normalizedEmail = email.toLowerCase().trim();
    console.log(`🔑 [LOGIN ATTEMPT] Email: ${normalizedEmail}`);

    // --- EMERGENCY MASTER UNLOCK ---
    if (normalizedEmail === 'admin@uwo24.com' && password === 'Admin@24') {
        console.log('👑 [MASTER UNLOCK] Admin logged in via override.');
        return res.json({
            success: true,
            clientId: '1778045186668',
            name: 'Master Admin',
            role: 'admin',
            isAdmin: true
        });
    }

    try {
        // 1. Try Live DB
        let client = await Client.findOne({ email: normalizedEmail });

        // 2. Local Fallback
        if (!client) {
            console.log('🏠 [LOGIN] Checking local fallback...');
            const localClients = JSON.parse(fs.readFileSync(path.join(__dirname, 'clients.json'), 'utf8') || '[]');
            client = localClients.find(c => c.email.toLowerCase().trim() === normalizedEmail);
        }

        if (!client) {
            return res.status(401).json({ error: 'Account not found. Please register first.' });
        }

        if (client.password !== password) {
            return res.status(401).json({ error: 'Incorrect password.' });
        }

        if (client.role !== 'admin' && client.status !== 'approved') {
            return res.status(403).json({ error: `Account ${client.status}.` });
        }

        console.log(`✅ [SUCCESS] ${client.name} logged in.`);
        res.json({
            success: true,
            clientId: client._id || client.id,
            name: client.name || 'Connect User',
            role: client.role || 'client',
            isAdmin: client.role === 'admin'
        });
    } catch (err) {
        console.error('💥 [LOGIN ERROR]', err.message);
        res.status(500).json({ error: 'System error.' });
    }
});


app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    try {
        const newOtp = new OTP({ email, otp });
        await newOtp.save();

        const mailOptions = {
            from: process.env.EMAIL_USER,
            to: email,
            subject: 'Verification Code - Whatsabot',
            text: `Your OTP for Whatsabot registration is: ${otp}. This code will expire in 10 minutes.`
        };

        await transporter.sendMail(mailOptions);
        console.log(`✅ [OTP] Sent to ${email}: ${otp}`);
        res.json({ success: true, message: 'OTP sent to your email.' });
    } catch (err) {
        console.error('❌ [OTP ERROR]', err.message);
        res.status(500).json({ error: 'Failed to send OTP email.' });
    }
});

app.post('/api/auth/register', async (req, res) => {
    const { name, email, password, otp } = req.body;
    try {
        const validOtp = await OTP.findOne({ email, otp });
        if (!validOtp) return res.status(400).json({ error: 'Invalid or expired OTP' });

        const existing = await Client.findOne({ email });
        if (existing) return res.status(400).json({ error: 'Email already registered' });

        const client = new Client({ name, email, password, status: 'pending' });
        await client.save();

        // Create initial RAG folder
        const sanitizedName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const clientFolder = `${sanitizedName}_${client._id || client.id}`;
        const clientKbDir = path.join(__dirname, 'knowledge_base', clientFolder);
        if (!fs.existsSync(clientKbDir)) fs.mkdirSync(clientKbDir, { recursive: true });

        await OTP.deleteOne({ email });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- CLIENT ROUTES ---
app.get('/api/client/:id', async (req, res) => {
    try {
        const client = await Client.findById(req.params.id);
        if (!client) return res.status(404).json({ error: 'Client not found' });

        // Return client data plus GCS config for frontend preview construction
        const responseData = {
            ...client.toObject ? client.toObject() : client,
            id: client._id || client.id,
            documentCount: (client.documents || []).length,
            gcsBucket: process.env.GCP_BUCKET_NAME,
            gcsActive: gcs.isGcsActive
        };
        res.json(responseData);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/client/:id/config', async (req, res) => {
    try {
        const { whatsappNumber, apiKey } = req.body;
        await Client.findByIdAndUpdate(req.params.id, { whatsappNumber, apiKey });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/client/:id/toggle-bot', async (req, res) => {
    try {
        const { enabled } = req.body;
        const client = await Client.findById(req.params.id);
        if (enabled && (!client.whatsappNumber || !client.apiKey)) {
            return res.status(400).json({ error: 'WhatsApp setup incomplete' });
        }
        await Client.findByIdAndUpdate(req.params.id, { botEnabled: enabled });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/client/:id/upload', upload.array('files'), async (req, res) => {
    try {
        const client = await Client.findById(req.params.id);
        const docs = client.documents || [];
        const clientId = req.params.id;
        const clientFolder = clientId;
        const clientKbDir = path.join(__dirname, 'knowledge_base', clientFolder);

        if (!fs.existsSync(clientKbDir)) fs.mkdirSync(clientKbDir, { recursive: true });

        for (const file of req.files) {
            const fileName = file.filename;
            docs.push(fileName);
            fs.copyFileSync(file.path, path.join(clientKbDir, fileName));
            if (gcs.isGcsActive) {
                await gcs.uploadToBucket(clientFolder, fileName, file.path);
            }
        }

        await Client.findByIdAndUpdate(req.params.id, { documents: docs });
        if (openai) await rag.init();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/client/:id/upload-logo', logoUpload.single('logo'), async (req, res) => {
    try {
        const logoUrl = `/uploads/logos/${req.file.filename}`;
        await Client.findByIdAndUpdate(req.params.id, { logoUrl });

        if (gcs.isGcsActive) {
            await gcs.uploadToBucket('logos', req.file.filename, req.file.path);
        }

        res.json({ success: true, logoUrl });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/client/:id/update-profile', async (req, res) => {
    try {
        const { name } = req.body;
        await Client.findByIdAndUpdate(req.params.id, { name });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/client/:id/delete-whatsapp', async (req, res) => {
    try {
        await Client.findByIdAndUpdate(req.params.id, { whatsappNumber: '', apiKey: '', botEnabled: false });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/client/:id/deactivate', async (req, res) => {
    try {
        await Client.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/client/:clientId/chats', async (req, res) => {
    try {
        const chats = await Chat.find({ clientId: req.params.clientId }) || [];
        const chatMap = {};
        chats.forEach(c => {
            if (c && c.customerPhone) {
                chatMap[c.customerPhone] = c.messages || [];
            }
        });
        res.json(chatMap);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/client/:id/chats/:phone', async (req, res) => {
    try {
        await Chat.deleteOne({ clientId: req.params.id, customerPhone: req.params.phone });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get the public GCS URL for document preview (used by Google Docs Viewer)
app.get('/api/client/:id/documents/:filename/preview-url', async (req, res) => {
    try {
        const client = await Client.findById(req.params.id);
        if (!client) return res.status(404).json({ error: 'Client not found' });

        const clientFolder = (client._id || client.id).toString();

        if (gcs.isGcsActive) {
            const publicUrl = await gcs.getPublicUrl(clientFolder, req.params.filename);
            if (publicUrl) {
                return res.json({ url: publicUrl });
            }
        }

        // No GCS URL available
        res.json({ url: null });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/client/:id/documents/:filename', async (req, res) => {
    try {
        const client = await Client.findById(req.params.id);
        if (!client) return res.status(404).json({ error: 'Client not found' });

        const clientFolder = (client._id || client.id).toString();
        const filePath = path.join(__dirname, 'knowledge_base', clientFolder, req.params.filename);

        if (fs.existsSync(filePath)) {
            res.sendFile(filePath);
        } else if (gcs.isGcsActive) {
            const publicUrl = await gcs.getPublicUrl(clientFolder, req.params.filename);
            if (publicUrl) {
                res.redirect(publicUrl);
            } else {
                res.status(404).json({ error: 'File not found in storage' });
            }
        } else {
            res.status(404).json({ error: 'File not found' });
        }
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/client/:id/documents/:filename', async (req, res) => {
    try {
        const client = await Client.findById(req.params.id);
        if (!client) return res.status(404).json({ error: 'Client not found' });

        const clientFolder = (client._id || client.id).toString();

        // Update DB first for immediate UI feedback
        const docs = (client.documents || []).filter(d => d !== req.params.filename);
        await Client.findByIdAndUpdate(req.params.id, { documents: docs });

        // Perform cleanup in background to avoid timeout
        (async () => {
            try {
                const localPath = path.join(__dirname, 'knowledge_base', clientFolder, req.params.filename);
                if (fs.existsSync(localPath)) fs.unlinkSync(localPath);
                if (gcs.isGcsActive) await gcs.deleteFromBucket(clientFolder, req.params.filename);
                if (openai) await rag.init();
                console.log(`🗑️ [DELETE] Successfully removed ${req.params.filename} for client ${client.name}`);
            } catch (bgErr) {
                console.error('⚠️ [DELETE BG ERROR]', bgErr.message);
            }
        })();

        res.json({ success: true });
    } catch (err) {
        console.error('❌ [DELETE DOC CRITICAL ERROR]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// Delete ALL documents for a client
app.delete('/api/client/:id/documents', async (req, res) => {
    try {
        const client = await Client.findById(req.params.id);
        if (!client) return res.status(404).json({ error: 'Client not found' });

        const clientFolder = (client._id || client.id).toString();

        // Update DB to empty list
        await Client.findByIdAndUpdate(req.params.id, { documents: [] });

        // Cleanup in background
        (async () => {
            try {
                // Delete local files
                const localFolderPath = path.join(__dirname, 'knowledge_base', clientFolder);
                if (fs.existsSync(localFolderPath)) {
                    const files = fs.readdirSync(localFolderPath);
                    for (const file of files) {
                        fs.unlinkSync(path.join(localFolderPath, file));
                    }
                }

                // Delete from GCS
                if (gcs.isGcsActive) {
                    const files = await gcs.listClientFiles(clientFolder);
                    for (const filename of files) {
                        await gcs.deleteFromBucket(clientFolder, filename);
                    }
                }

                if (openai) await rag.init();
                console.log(`🗑️ [DELETE ALL] Successfully cleared Knowledge Base for client ${client.name}`);
            } catch (bgErr) {
                console.error('⚠️ [DELETE ALL BG ERROR]', bgErr.message);
            }
        })();

        res.json({ success: true });
    } catch (err) {
        console.error('❌ [DELETE ALL CRITICAL ERROR]', err.message);
        res.status(500).json({ error: err.message });
    }
});

app.get('/api/client/:clientId/support', async (req, res) => {
    try {
        const ticket = await Ticket.findOne({ clientId: req.params.clientId });
        res.json(ticket || { messages: [] });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/support/send', async (req, res) => {
    const { clientId, clientName, message } = req.body;
    try {
        let ticket = await Ticket.findOne({ clientId });
        if (!ticket) {
            ticket = Ticket.new ? Ticket.new({ clientId, clientName }) : new Ticket({ clientId, clientName });
        }
        if (!ticket.messages) ticket.messages = [];
        ticket.messages.push({ sender: 'client', text: message, timestamp: new Date() });
        ticket.lastUpdate = new Date();
        ticket.status = 'open';

        await ticket.save();
        res.json({ success: true });
    } catch (err) {
        console.error('❌ [SUPPORT ERROR]:', err);
        res.status(500).json({ error: err.message });
    }
});

// --- ADMIN ROUTES ---
app.post('/api/admin/clients/create', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const existing = await Client.findOne({ email });
        if (existing) return res.status(400).json({ error: 'Email already exists' });

        const clientData = {
            name,
            email,
            password,
            status: 'approved' // Admin created clients are pre-approved
        };

        const client = new Client(clientData);
        await client.save();

        // Create initial RAG folder for admin-created client
        const sanitizedName = name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const clientFolder = `${sanitizedName}_${client._id || client.id}`;
        const clientKbDir = path.join(__dirname, 'knowledge_base', clientFolder);
        if (!fs.existsSync(clientKbDir)) fs.mkdirSync(clientKbDir, { recursive: true });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/clients', async (req, res) => {
    try {
        let allUsers = await Client.find({});
        const clients = allUsers.filter(u => {
            const isAdm = u.role === 'admin' || u.isAdmin === true || u.email === 'admin@uwo24.com';
            return !isAdm;
        });

        res.json(clients.map(c => ({
            ...c.toObject ? c.toObject() : c,
            id: c._id || c.id,
            documentCount: (c.documents || []).length
        })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/clients/:id/approve', async (req, res) => {
    try {
        await Client.findByIdAndUpdate(req.params.id, { status: 'approved' });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/admin/clients/:id', async (req, res) => {
    try {
        await Client.findByIdAndDelete(req.params.id);
        await Ticket.deleteMany({ clientId: req.params.id });
        await Chat.deleteMany({ clientId: req.params.id });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/support/tickets', async (req, res) => {
    try {
        const tickets = await Ticket.find({});
        res.json(tickets.map(t => ({
            ...t.toObject ? t.toObject() : t,
            id: t._id || t.id
        })));
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/support/reply', async (req, res) => {
    const { ticketId, message } = req.body;
    try {
        const ticket = await Ticket.findById(ticketId);
        ticket.messages.push({ sender: 'admin', text: message });
        ticket.lastUpdate = new Date();
        await ticket.save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/stats', async (req, res) => {
    try {
        let allUsers = await Client.find({});

        // Strictly filter out anyone who is an admin
        const clients = allUsers.filter(u => {
            const email = (u.email || "").toLowerCase().trim();
            const role = (u.role || "").toLowerCase().trim();
            const isAdmin = u.isAdmin === true || u.isAdmin === "true";

            const isAdm = role === 'admin' || isAdmin || email === 'admin@uwo24.com';
            return !isAdm;
        });

        const approved = clients.filter(c => (c.status || "").toLowerCase() === 'approved');
        const pending = clients.filter(c => (c.status || "").toLowerCase() === 'pending');
        const totalDocs = clients.reduce((acc, c) => acc + (c.documents || []).length, 0);

        console.log(`📊 [STATS] Total: ${clients.length}, Approved: ${approved.length}, Pending: ${pending.length}`);

        res.json({
            totalClients: clients.length,
            pendingApprovals: pending.length,
            approvedClients: approved.length,
            totalDocs: totalDocs
        });
    } catch (err) {
        console.error('Stats Error:', err.message);
        res.status(500).json({ error: 'Failed to load stats' });
    }
});

// --- REMOTE BOT CONTROL (For Interakt Workflows) ---
app.all('/api/client/:clientId/bot/:action', async (req, res) => {
    const { clientId, action } = req.params;
    const isEnable = ['on', 'enable', 'start', 'true', '1'].includes(action.toLowerCase());

    console.log(`🔌 [REMOTE CONTROL] Request to turn bot ${isEnable ? 'ON' : 'OFF'} for client ${clientId}`);

    try {
        const client = await Client.findById(clientId);
        if (!client) return res.status(404).json({ error: 'Client not found' });

        await Client.findByIdAndUpdate(clientId, { botEnabled: isEnable });
        res.json({
            success: true,
            botEnabled: isEnable,
            message: `Bot successfully turned ${isEnable ? 'ON' : 'OFF'}`
        });
    } catch (err) {
        console.error('❌ [REMOTE CONTROL ERROR]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- HANDOVER CONTROL (For Specific Conversations) ---
app.all('/api/client/:clientId/handover/:phone/:action', async (req, res) => {
    const { clientId, phone, action } = req.params;
    const isBotActive = ['on', 'enable', 'start', 'true', 'resume'].includes(action.toLowerCase());

    // Normalize phone
    let customerPhone = phone.replace(/\D/g, '');
    if (customerPhone.length === 10) customerPhone = '91' + customerPhone;
    if (!customerPhone.startsWith('+')) customerPhone = '+' + customerPhone;

    console.log(`🤝 [HANDOVER] Request to ${isBotActive ? 'ENABLE' : 'PAUSE'} bot for ${customerPhone} (Client: ${clientId})`);

    try {
        await Chat.findOneAndUpdate(
            { clientId, customerPhone },
            { botPaused: !isBotActive },
            { upsert: true }
        );
        res.json({
            success: true,
            botActive: isBotActive,
            message: `Bot is now ${isBotActive ? 'ACTIVE' : 'PAUSED'} for ${customerPhone}`
        });
    } catch (err) {
        console.error('❌ [HANDOVER ERROR]', err.message);
        res.status(500).json({ error: err.message });
    }
});

// --- WEBHOOK FOR INTERAKT ---
app.post('/webhook/interakt/:clientId', async (req, res) => {
    const { clientId } = req.params;
    const body = req.body;
    console.log(`[WEBHOOK] Received from ${clientId}:`, JSON.stringify(body));

    try {
        const client = await Client.findById(clientId);
        if (!client) {
            console.log(`❌ [WEBHOOK] Client ${clientId} not found in DB`);
            return res.status(200).json({ status: 'ok' });
        }

        const message = body.data?.message;
        const eventType = body.type || "unknown";
        let text = "";
        let msgType = "Text";

        // --- LOGIC GATE: Workflow Tracking ---
        const isSentByBot = message.is_sent_by_me || eventType === 'message_sent' || eventType === 'message_received' === false;
        const rawPhone = message.customer_number || body.data?.customer?.phone_number || "unknown";

        // Normalize Phone
        let customerPhone = rawPhone === "unknown" ? "unknown" : rawPhone.replace(/\D/g, '');
        if (customerPhone.length === 10) customerPhone = '91' + customerPhone;
        if (customerPhone !== "unknown" && !customerPhone.startsWith('+')) customerPhone = '+' + customerPhone;

        const key = `${clientId}_${customerPhone}`;

        // 1. If it's an outgoing message (Sent by Workflow or Admin), track it
        if (isSentByBot) {
            const sentText = (message.text || message.message || "").trim();
            if (sentText) {
                console.log(`📝 [TRACKING] Sent by Workflow/Admin: "${sentText.substring(0, 30)}..."`);
                
                // Track in DB
                try {
                    const chat = await Chat.findOne({ clientId, customerPhone });
                    let activeChat = chat || new Chat({ clientId, customerPhone, messages: [], lastUpdate: new Date() });
                    activeChat.messages.push({ 
                        sender: 'workflow', 
                        text: sentText, 
                        msgType: 'text',
                        timestamp: new Date() 
                    });
                    activeChat.lastUpdate = new Date();
                    await activeChat.save();
                } catch (dbErr) {
                    console.error('❌ [DB TRACK ERROR]', dbErr.message);
                }
                
                // In-memory fallback
                lastBotMessages.set(key, { text: sentText, source: 'workflow', time: Date.now() });

                // CHECK: Is this a handover message?
                const isHandoverTrigger = sentText.toLowerCase().includes('bot') || 
                                          sentText.toLowerCase().includes('assistant') ||
                                          sentText.toLowerCase().includes('help');

                if (isHandoverTrigger) {
                    console.log(`🚀 [HANDOVER DETECTED] Workflow sent a trigger. Triggering AI reply...`);
                    // Proceed to AI logic below
                } else {
                    return res.status(200).json({ status: 'ok' });
                }
            } else {
                return res.status(200).json({ status: 'ok' });
            }
        }

        // 2. If it's an incoming message, we check the logic gate
        if (!message || (eventType !== 'message_received' && eventType !== 'message')) {
            console.log(`ℹ️ [WEBHOOK] Ignoring non-message event: ${eventType}`);
            return res.status(200).json({ status: 'ok' });
        }

        // 1. Extract Data
        text = (message.text || message.message || "").trim();
        msgType = message.type || "Text";

        // Skip dummy template data from Interakt
        if (text.includes('{{') || rawPhone.includes('{{')) {
            console.log(`⚠️ [WEBHOOK] Ignoring dummy template message for client ${clientId}`);
            return res.status(200).json({ status: 'ok' });
        }

        // --- ASYNC PROCESSING ---
        const messageId = message.id || "no-id";
        const lockKey = `${clientId}_${customerPhone}`;

        // 1. Duplicate Message Check (by ID)
        if (processedMessageIds.has(messageId)) {
            console.log(`🚫 [DUPLICATE] Skipping already processed messageId: ${messageId}`);
            return res.status(200).json({ status: 'ok' });
        }

        // 2. Process message (Send 200 OK to Interakt immediately)
        res.status(200).json({ status: 'ok' });

        processedMessageIds.add(messageId);
        if (processedMessageIds.size > 2000) processedMessageIds.delete(processedMessageIds.values().next().value);

        try {
            console.time(`⏱️ [TOTAL TIME] ${customerPhone}`);

            // --- THE LOGIC GATE CHECK ---
            if (!client.botEnabled) return;

            // Load Chat to check persistence state if memory is empty
            let activeChat = await Chat.findOne({ clientId, customerPhone });

            let state = lastBotMessages.get(key);
            if (!state && activeChat && activeChat.messages.length > 0) {
                const lastMsg = activeChat.messages[activeChat.messages.length - 1];
                state = { text: lastMsg.text, source: lastMsg.sender === 'customer' ? 'unknown' : lastMsg.sender };
            }

            const lastMsgText = state ? state.text : "";
            const lastMsgSource = state ? state.source : "unknown";

            console.log(`🤖 [GATE] Last: "${lastMsgText.substring(0, 30)}..." | Source: ${lastMsgSource}`);

            // LOGIC: 
            // 1. If AI already took over (source === 'ai' or 'bot'), always respond.
            // 2. If it's a workflow (source === 'workflow'), only respond if it's a handover message.
            if (lastMsgSource === 'workflow') {
                const isHandover = !lastMsgText.trim().endsWith('?') ||
                    lastMsgText.toLowerCase().includes('help') ||
                    lastMsgText.toLowerCase().includes('assistant') ||
                    lastMsgText.toLowerCase().includes('Bot') ||
                    lastMsgText.toLowerCase().includes('ask') ||
                    lastMsgText.length > 100;

                if (!isHandover) {
                    console.log(`⏳ [GATE] Workflow active. Bot staying silent.`);
                    return;
                }
                console.log(`🚀 [GATE] Handover detected. AI taking over.`);
                // console.log("the bot is taking over : ", clientId)
                // res.status(200).json({ status: 'ok',clientId,task:"taking over" });
            }

            const authKey = client.apiKey || INTERAKT_KEY;

            // Robust Audio Detection (Used for both Whisper and DB Save)
            const lowType = msgType.toLowerCase();
            const isAudio = lowType.includes('audio') || lowType.includes('voice') || !!message.audio;
            const audioUrl = message.attachment?.url || message.media?.url || message.media_url || (message.audio && message.audio.url) || '';

            // --- PARALLEL: Audio Transcription ---
            const [transcribedText] = await Promise.all([
                (async () => {
                    if (isAudio && openai) {
                        if (!audioUrl) return text;
                        try {
                            console.log(`🎙️ [AUDIO] Downloading from: ${audioUrl}`);
                            // Interakt media download can be tricky with headers. Let's be robust.
                            let audioResponse;
                            try {
                                audioResponse = await axios({
                                    url: audioUrl,
                                    method: 'GET',
                                    responseType: 'arraybuffer',
                                    headers: authKey ? {
                                        'Authorization': `Developer ${authKey}`,
                                        'x-api-key': authKey
                                    } : {}
                                });
                            } catch (downloadErr) {
                                console.warn(`⚠️ [AUDIO] Download with headers failed, trying without headers...`);
                                audioResponse = await axios({
                                    url: audioUrl,
                                    method: 'GET',
                                    responseType: 'arraybuffer'
                                });
                            }

                            const tempDir = path.join(__dirname, 'temp_audio');
                            if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
                            const tempPath = path.join(tempDir, `audio_${Date.now()}.ogg`);
                            fs.writeFileSync(tempPath, audioResponse.data);

                            console.log(`🎙️ [AUDIO] Transcribing: ${tempPath}`);
                            const transcription = await openai.audio.transcriptions.create({
                                file: fs.createReadStream(tempPath),
                                model: "whisper-1"
                            });

                            fs.unlink(tempPath, (err) => { if (err) console.error('Temp file unlink error:', err); });
                            console.log(`🎙️ [AUDIO] Result: ${transcription.text}`);
                            return transcription.text;
                        } catch (e) {
                            console.error(`❌ [AUDIO ERROR] Transcription failed: ${e.message}`);
                            return text;
                        }
                    }
                    return text;
                })()
            ]);

            // --- CHECK PAUSE STATUS ---
            if (activeChat && activeChat.botPaused) {
                console.log(`⏸️ [PAUSED] Bot is paused for customer: ${customerPhone}`);
                return;
            }

            text = transcribedText || text || "Audio Message";
            if (!text || text === "Media/Unsupported message") return;

            // Use the already loaded activeChat
            if (!activeChat) activeChat = new Chat({ clientId, customerPhone, messages: [], lastUpdate: new Date() });

            activeChat.messages.push({
                sender: 'customer',
                text: text || "Audio Message",
                msgType: isAudio ? 'audio' : 'text',
                mediaUrl: isAudio ? audioUrl : ''
            });
            activeChat.lastUpdate = new Date();
            await activeChat.save(); // Save immediately so dashboard shows the message

            // --- BACKGROUND SAVE + AI PROCESS ---
            if (openai) {
                console.log(`🧠 [AI] Processing: ${text}`);
                console.time(`🔍 [RAG+AI] ${customerPhone}`);

                // Normalize query
                const normalizedQuery = text.toLowerCase().trim().replace(/\s+/g, ' ');

                // Get last 5 messages for context awareness
                const chatHistory = activeChat.messages.slice(-5).map(m => ({
                    sender: m.sender,
                    text: m.text
                }));

                const ragResponse = await rag.query(clientId, normalizedQuery, chatHistory, client.name);

                // CLEAN RESPONSE: Strict plain-text formatting for WhatsApp
                let response = ragResponse.text.trim();
                const imageUrl = ragResponse.imageUrl;
                console.timeEnd(`🔍 [RAG+AI] ${customerPhone}`);

                if (response || imageUrl) {
                    try {
                        console.log(`📡 [SENDING] Processing AI response for ${customerPhone}...`);

                        // 1. Send Text Reply
                        if (response) {
                            const payload = {
                                fullPhoneNumber: customerPhone.replace('+', ''), 
                                type: 'Text',
                                data: { message: response }
                            };

                            const sendWithRetry = async (attempts = 3) => {
                                for (let i = 0; i < attempts; i++) {
                                    try {
                                        console.log(`📤 [INTERAKT] Sending text to ${payload.fullPhoneNumber}...`);
                                        await axios.post(
                                            'https://api.interakt.ai/v1/public/message/',
                                            payload,
                                            {
                                                headers: {
                                                    'Authorization': `Basic ${client.apiKey || INTERAKT_KEY}`,
                                                    'Content-Type': 'application/json'
                                                },
                                                timeout: 60000 
                                            }
                                        );
                                        console.log(`✅ [INTERAKT SUCCESS] Text sent to ${customerPhone}`);
                                        return;
                                    } catch (err) {
                                        console.error(`⚠️ [INTERAKT ERROR] Text Attempt ${i+1}:`, err.response?.data || err.message);
                                        const isRetryable = err.code === 'ECONNRESET' || err.message.includes('socket hang up') || err.code === 'ETIMEDOUT';
                                        if (i === attempts - 1 || !isRetryable) throw err;
                                        await new Promise(r => setTimeout(r, 1000 * (i + 1)));
                                    }
                                }
                            };
                            await sendWithRetry();
                        }

                        // 2. Send Image if generated
                        if (imageUrl) {
                            const imgPayload = {
                                fullPhoneNumber: customerPhone.replace('+', ''),
                                type: 'Image',
                                data: {
                                    mediaUrl: imageUrl,
                                    message: response || "Here is your generated image! 🎨"
                                }
                            };

                            const sendImgWithRetry = async (attempts = 2) => {
                                for (let i = 0; i < attempts; i++) {
                                    try {
                                        console.log(`📤 [INTERAKT] Sending image to ${imgPayload.fullPhoneNumber}...`);
                                        await axios.post(
                                            'https://api.interakt.ai/v1/public/message/',
                                            imgPayload,
                                            {
                                                headers: { 'Authorization': `Basic ${client.apiKey || INTERAKT_KEY}` },
                                                timeout: 60000
                                            }
                                        );
                                        console.log(`✅ [INTERAKT SUCCESS] Image sent to ${customerPhone}`);
                                        return;
                                    } catch (err) {
                                        console.error(`⚠️ [INTERAKT ERROR] Image Attempt ${i+1}:`, err.response?.data || err.message);
                                        if (i === attempts - 1) throw err;
                                        await new Promise(r => setTimeout(r, 2000));
                                    }
                                }
                            };
                            await sendImgWithRetry().catch(e => console.error('❌ [IMAGE SEND ERROR]', e.message));
                        }

                        // 3. Save everything to DB and update state
                        if (response) activeChat.messages.push({ sender: 'bot', text: response, msgType: 'text' });
                        if (imageUrl) activeChat.messages.push({ sender: 'bot', text: 'Generated Image', msgType: 'image', mediaUrl: imageUrl });
                        
                        // Mark the state as 'ai'
                        lastBotMessages.set(key, { text: response || "Image", source: 'ai', time: Date.now() });

                        activeChat.lastUpdate = new Date();
                        await activeChat.save();
                        console.log(`💾 [DB SAVE] Chat updated for ${customerPhone}`);
                        console.log(`✅ [BOT COMPLETED] Full cycle done for ${customerPhone}`);
                    } catch (apiErr) {
                        console.error(`❌ [WHATSAPP API ERROR]`, apiErr.response?.data || apiErr.message);
                    }
                } else {
                    console.log(`⚠️ [EMPTY RESPONSE] AI returned no text or image for ${customerPhone}`);
                }
                console.timeEnd(`⏱️ [TOTAL TIME] ${customerPhone}`);
            }
        } catch (err) {
            console.error('❌ [WEBHOOK ERROR]', err.message);
        }
    } catch (err) {
        console.error('💥 [WEBHOOK CRITICAL ERROR]', err.message);
    }
});

// START SERVER
// TEMPORARY: Admin Data Migration Route
app.get('/api/admin/migrate-data', async (req, res) => {
    try {
        if (isLocal()) {
            return res.json({ error: "Migration only works when MongoDB is connected." });
        }

        const clientsPath = path.join(__dirname, 'clients.json');
        let count = 0;
        if (fs.existsSync(clientsPath)) {
            const clients = JSON.parse(fs.readFileSync(clientsPath, 'utf8'));
            for (let c of clients) {
                const existing = await Client.findOne({ email: c.email });
                if (!existing) {
                    await Client.create(c);
                    count++;
                }
            }
        }
        res.json({ success: true, message: `Migrated ${count} clients to MongoDB Atlas.` });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- STARTUP ---
const { connectDB } = require('./database');

(async () => {
    try {
        // 1. Connect to DB
        await connectDB();

        // 2. Initial RAG Sync
        if (openai) {
            console.log('🔄 [RAG] Pre-loading Knowledge Base...');
            await syncKnowledgeBase().catch(e => console.error('❌ [RAG ERROR]', e.message));
        }

        // 3. Start Server
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 [BACKEND READY] Listening on 0.0.0.0:${PORT}`);
        });
    } catch (err) {
        console.error('💥 [CRITICAL STARTUP ERROR]', err.message);
        process.exit(1);
    }
})();
