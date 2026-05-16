require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const axios = require('axios');

const nodemailer = require('nodemailer');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');

const JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret-for-dev-only';

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
const { Client, Ticket, Chat, OTP, Campaign, Automation, AutoState, isLocal } = require('./database');

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    credentials: true
}));
app.options(/.*/, cors());

app.use(express.json());

// --- SECURITY MIDDLEWARE ---
const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (!token) return res.status(401).json({ error: 'Access denied. Token missing.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: 'Invalid or expired token.' });
        
        // Ensure user is only accessing their own data unless they are an admin
        if (req.params.id && req.params.id !== user.clientId && !user.isAdmin) {
            return res.status(403).json({ error: 'Unauthorized access to this resource.' });
        }
        
        req.user = user;
        next();
    });
};

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
        const masterToken = jwt.sign(
            { clientId: '1778045186668', role: 'admin', isAdmin: true },
            JWT_SECRET,
            { expiresIn: '24h' }
        );
        return res.json({
            success: true,
            token: masterToken,
            clientId: '1778045186668',
            name: 'Master Admin',
            role: 'admin',
            isAdmin: true
        });
    }

    try {
        // 1. Find Client (uses Atlas or JSON based on connection)
        const client = await Client.findOne({ email: normalizedEmail });

        if (!client) {
            console.log(`❌ [LOGIN] Account not found: ${normalizedEmail}`);
            return res.status(401).json({ error: 'Account not found. Please register first.' });
        }

        // 2. Check Password
        if (client.password !== password) {
            console.log(`❌ [LOGIN] Incorrect password for: ${normalizedEmail}`);
            return res.status(401).json({ error: 'Incorrect password.' });
        }

        if (client.role !== 'admin' && client.status !== 'approved') {
            return res.status(403).json({ error: `Account ${client.status}.` });
        }

        console.log(`✅ [SUCCESS] ${client.name} logged in.`);

        const token = jwt.sign(
            { 
                clientId: client._id || client.id, 
                role: client.role || 'client',
                isAdmin: client.role === 'admin'
            }, 
            JWT_SECRET, 
            { expiresIn: '24h' }
        );

        res.json({
            success: true,
            token,
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

app.post('/api/auth/verify-otp', async (req, res) => {
    const { email, otp } = req.body;
    try {
        const validOtp = await OTP.findOne({ email, otp });
        if (!validOtp) return res.status(400).json({ error: 'Invalid or expired OTP' });
        res.json({ success: true, message: 'OTP verified.' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/reset-password', async (req, res) => {
    const { email, otp, newPassword } = req.body;
    try {
        const validOtp = await OTP.findOne({ email, otp });
        if (!validOtp) return res.status(400).json({ error: 'Invalid or expired OTP' });

        const client = await Client.findOne({ email });
        if (!client) return res.status(404).json({ error: 'Account not found.' });

        client.password = newPassword;
        await client.save();

        await OTP.deleteOne({ email });
        res.json({ success: true, message: 'Password reset successful.' });
    } catch (err) {
        console.error('❌ [RESET ERROR]', err.message);
        res.status(500).json({ error: 'Failed to reset password.' });
    }
});

app.post('/api/client/:id/change-password', authenticateToken, async (req, res) => {
    const { oldPassword, newPassword } = req.body;
    try {
        const client = await Client.findById(req.params.id);
        if (!client) return res.status(404).json({ error: 'Client not found.' });

        if (client.password !== oldPassword) {
            return res.status(401).json({ error: 'Current password incorrect.' });
        }

        client.password = newPassword;
        await client.save();
        res.json({ success: true, message: 'Password updated successfully.' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// --- CLIENT ROUTES (PROTECTED) ---
app.get('/api/client/:id', authenticateToken, async (req, res) => {
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

app.post('/api/client/:id/config', authenticateToken, async (req, res) => {
    try {
        const { whatsappNumber, apiKey } = req.body;
        await Client.findByIdAndUpdate(req.params.id, { whatsappNumber, apiKey });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/client/:id/toggle-bot', authenticateToken, async (req, res) => {
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

app.post('/api/client/:id/upload', authenticateToken, upload.array('files'), async (req, res) => {
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

app.post('/api/client/:id/upload-logo', authenticateToken, logoUpload.single('logo'), async (req, res) => {
    try {
        const logoUrl = `/uploads/logos/${req.file.filename}`;
        await Client.findByIdAndUpdate(req.params.id, { logoUrl });

        if (gcs.isGcsActive) {
            await gcs.uploadToBucket('logos', req.file.filename, req.file.path);
        }

        res.json({ success: true, logoUrl });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/client/:id/update-profile', authenticateToken, async (req, res) => {
    try {
        const { name } = req.body;
        await Client.findByIdAndUpdate(req.params.id, { name });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/client/:id/delete-whatsapp', authenticateToken, async (req, res) => {
    try {
        await Client.findByIdAndUpdate(req.params.id, { whatsappNumber: '', apiKey: '', botEnabled: false });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/client/:id/deactivate', authenticateToken, async (req, res) => {
    try {
        await Client.findByIdAndDelete(req.params.id);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});
app.get('/api/client/:id/chats', authenticateToken, async (req, res) => {
    try {
        const chats = await Chat.find({ clientId: req.params.id }) || [];
        const chatMap = {};
        chats.forEach(c => {
            chatMap[c.customerPhone] = {
                phone: c.customerPhone,
                lastUpdate: c.lastUpdate,
                botPaused: c.botPaused,
                messages: c.messages
            };
        });
        res.json(chatMap);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/client/:clientId/contacts', authenticateToken, async (req, res) => {
    try {
        const chats = await Chat.find({ clientId: req.params.clientId }) || [];
        const contacts = chats.map(c => ({
            phone: c.customerPhone,
            // Try to find a name if any message or data has it, for now just phone
            name: c.customerPhone,
            lastMsgAt: c.lastUpdate
        }));

        // Remove duplicates
        const uniqueContacts = Array.from(new Set(contacts.map(c => c.phone)))
            .map(phone => contacts.find(c => c.phone === phone));

        res.json(uniqueContacts);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/client/:id/chats/:phone', authenticateToken, async (req, res) => {
    try {
        await Chat.deleteOne({ clientId: req.params.id, customerPhone: req.params.phone });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Get the public GCS URL for document preview (used by Google Docs Viewer)
app.get('/api/client/:id/documents/:filename/preview-url', authenticateToken, async (req, res) => {
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

app.get('/api/client/:id/documents/:filename', authenticateToken, async (req, res) => {
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

app.delete('/api/client/:id/documents/:filename', authenticateToken, async (req, res) => {
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
app.delete('/api/client/:id/documents', authenticateToken, async (req, res) => {
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

    // Normalize phone (Check URL params first, then Body)
    const rawPhone = phone || req.body.phone_number || req.body.phone || req.body.customer_number || "";
    let customerPhone = rawPhone.replace(/\D/g, '');

    if (!customerPhone) {
        // Log the full request for debugging
        console.error(`❌ [HANDOVER ERROR] No phone number found in URL or Body!`);
        console.log('📦 [DEBUG] Request Body:', JSON.stringify(req.body));
        return res.status(400).json({ error: 'Phone number is required' });
    }

    if (customerPhone.length === 10) customerPhone = '91' + customerPhone;
    if (!customerPhone.startsWith('+')) customerPhone = '+' + customerPhone;

    try {
        const client = await Client.findById(clientId);
        if (!client) return res.status(404).json({ error: 'Client not found' });

        await Chat.findOneAndUpdate(
            { clientId, customerPhone },
            { botPaused: !isBotActive },
            { upsert: true }
        );
        console.log(`🤝 [HANDOVER] Bot is now ${isBotActive ? 'ACTIVE' : 'PAUSED'} for ${customerPhone}`);

        // If activating, send an immediate "Welcome/Assistant" message
        if (isBotActive && openai) {
            (async () => {
                try {
                    const chat = await Chat.findOne({ clientId, customerPhone });
                    const chatHistory = chat ? chat.messages.slice(-5).map(m => ({ sender: m.sender, text: m.text })) : [];

                    // Trigger RAG with a "handover" context
                    const ragResponse = await rag.query(clientId, "The customer has just handed over control to you. Greet them and ask how you can help.", chatHistory, client.name);

                    if (ragResponse.text) {
                        await axios.post(
                            'https://api.interakt.ai/v1/public/message/',
                            {
                                fullPhoneNumber: customerPhone.replace('+', ''),
                                type: 'Text',
                                data: { message: ragResponse.text.trim() }
                            },
                            {
                                headers: {
                                    'Authorization': `Basic ${client.apiKey || INTERAKT_KEY}`,
                                    'Content-Type': 'application/json'
                                }
                            }
                        );
                        console.log(`✅ [HANDOVER REPLY] Sent welcome message to ${customerPhone}`);
                    }
                } catch (err) {
                    console.error('❌ [HANDOVER AI ERROR]', err.message);
                }
            })();
        }

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

// --- BULK SENDING ---
app.post('/api/client/:id/bulk-send', authenticateToken, async (req, res) => {
    const { id } = req.params;
    const { contacts, message, mediaUrl, mediaType, fileName } = req.body;

    try {
        const client = await Client.findById(id);
        if (!client) return res.status(404).json({ error: 'Client not found' });

        console.log(`🚀 [BULK SEND] Client ${client.name} starting campaign for ${contacts.length} recipients. Media: ${mediaType || 'None'}`);

        // Process directly instead of background IIFE to ensure completion on Cloud Run
        let sent = 0;
        let failed = 0;

        // Prepare API Key
        let authKey = client.apiKey || INTERAKT_KEY;
        // If key is not base64 encoded (doesn't end with = or contains spaces), encode it
        if (authKey && !authKey.includes(':') && !authKey.endsWith('=')) {
            authKey = Buffer.from(authKey + ':').toString('base64');
        }

        for (let contact of contacts) {
            try {
                // Basic cleanup of phone number
                let phone = contact.split(',')[0].replace(/\D/g, '');
                if (phone.length === 10) phone = '91' + phone;

                const { mediaList = [], automationId } = req.body;

                // Personalization check
                let personalizedMsg = message;
                if (contact.includes(',')) {
                    const name = contact.split(',')[1];
                    personalizedMsg = message.replace(/{{name}}/g, name);
                }

                // 1. Send Main Text Message first
                if (personalizedMsg) {
                    const textPayload = {
                        fullPhoneNumber: phone,
                        type: 'Text',
                        data: { message: personalizedMsg }
                    };
                    await axios.post('https://api.interakt.ai/v1/public/message/', textPayload, {
                        headers: {
                            'Authorization': `Basic ${authKey}`,
                            'Content-Type': 'application/json'
                        }
                    });
                }

                // 2. Send all media attachments sequentially
                for (const media of mediaList) {
                    const mediaPayload = {
                        fullPhoneNumber: phone,
                        type: media.type,
                        data: {
                            mediaUrl: media.url,
                            message: '',
                            fileName: media.fileName || 'file'
                        }
                    };
                    await axios.post('https://api.interakt.ai/v1/public/message/', mediaPayload, {
                        headers: {
                            'Authorization': `Basic ${authKey}`,
                            'Content-Type': 'application/json'
                        }
                    });
                    await new Promise(r => setTimeout(r, 500));
                }

                // --- REGISTER SMART AUTOMATION (Multi-Stage) ---
                if (automationId) {
                    const automation = await Automation.findById(automationId);
                    if (automation && automation.stages && automation.stages.length > 0) {
                        const firstStage = automation.stages[0]; // Stage 0 is the initial one (linked to bulk)

                        const state = new AutoState({
                            clientId: id,
                            automationId: automationId,
                            customerPhone: phone,
                            currentStageIndex: 0,
                            status: 'pending',
                            nextReminderIndex: 0,
                            nextReminderAt: (firstStage.reminders && firstStage.reminders.length > 0)
                                ? (firstStage.reminders[0].fixedTime
                                    ? new Date(firstStage.reminders[0].fixedTime)
                                    : new Date(Date.now() + ((firstStage.reminders[0].delayHours || 1) * 3600000)))
                                : null
                        });
                        await state.save();
                    }
                }

                sent++;
                // Rate limiting
                await new Promise(r => setTimeout(r, 500));
            } catch (err) {
                failed++;
                console.error(`❌ [BULK SEND ERROR] to ${contact}:`, err.response?.data || err.message);
            }
        }
        console.log(`✅ [BULK COMPLETE] Client ${client.name}: Sent ${sent}, Failed ${failed}`);
        res.json({ success: true, totalSent: sent, totalFailed: failed });

    } catch (err) {
        console.error('❌ [BULK CRITICAL ERROR]', err.message);
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
        const isSentByBot = message.is_sent_by_me === true || message.sender_type === 'Admin' || message.sender_type === 'App' || message.chat_message_type === 'AdminMessage' || eventType === 'message_sent';
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
                const isHandoverTrigger = sentText.toLowerCase().includes('ask anything');

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

        // Extract Data
        text = (message.text || message.message || "").trim();
        msgType = message.type || "Text";

        // Check if variables are not replaced (Interakt Test Mode)
        if ((rawPhone && rawPhone.includes('{{')) || (text && text.includes('{{'))) {
            console.warn(`⚠️ [INTERAKT TEST] Detected unreplaced variables. Please test with a REAL WhatsApp message, not the "Test" button.`);
        }

        // --- ASYNC PROCESSING ---
        const messageId = message.id || "no-id";
        const lockKey = `${clientId}_${customerPhone}`;

        // 1. Duplicate Message Check (by ID) - Skip check if ID is "no-id"
        if (messageId !== "no-id" && processedMessageIds.has(messageId)) {
            console.log(`🚫 [DUPLICATE] Skipping already processed messageId: ${messageId}`);
            return res.status(200).json({ status: 'ok' });
        }

        // 2. Process message (Send 200 OK to Interakt immediately)
        res.status(200).json({ status: 'ok' });

        processedMessageIds.add(messageId);
        if (processedMessageIds.size > 2000) processedMessageIds.delete(processedMessageIds.values().next().value);

        // --- CONCURRENCY LOCK: Prevent overlapping requests for same phone ---
        if (inFlightRequests.has(lockKey)) {
            console.log(`⏳ [LOCK] Already processing a request for ${customerPhone}. Skipping.`);
            return;
        }
        inFlightRequests.add(lockKey);

        try {
                console.time(`⏱️ [TOTAL TIME] ${customerPhone}`);

                // Fetch Chat to check bot status
                let activeChat = await Chat.findOne({ clientId, customerPhone });

                // --- THE LOGIC GATE CHECK ---
                if (!client.botEnabled) return;
                let automationHandled = false;

                // --- ADVANCED MULTI-STAGE AUTOMATION ---
                try {
                    const cleanPhone = customerPhone.replace(/\+/g, '');

                    // Check 1: Is AI Bot session currently active?
                    const isBotSessionActive = activeChat && activeChat.handoverActive && activeChat.handoverExpiresAt && new Date(activeChat.handoverExpiresAt) > new Date();

                    // Check 2: Does this message contain a trigger keyword?
                    const currentTextLower = text.toLowerCase();
                    const triggerKeywords = client.botTriggerKeywords || [];
                    const isTriggerKeyword = triggerKeywords.length > 0
                        ? triggerKeywords.some(k => currentTextLower.includes(k.toLowerCase()))
                        : currentTextLower.includes('ask anything');

                    // GATE: Bot active OR trigger keyword → skip ALL automation
                    if (isBotSessionActive || isTriggerKeyword) {
                        if (isTriggerKeyword && !isBotSessionActive) {
                            console.log(`🚨 [GATE] Trigger keyword inside automation. Bot taking over for ${cleanPhone}`);
                            // Close the automation so reminders stop too
                            await AutoState.findOneAndUpdate(
                                { clientId, customerPhone: cleanPhone, status: 'pending' },
                                { status: 'completed', lastInteractionAt: new Date() }
                            );
                        } else {
                            console.log(`🤖 [GATE] AI session active. Skipping automation for ${cleanPhone}`);
                        }
                        // Do NOT set automationHandled — let the AI logic below run
                    } else {
                        // GATE: No bot session, no trigger → process automation stage
                        const activeAuto = await AutoState.findOne({ clientId, customerPhone: cleanPhone, status: 'pending' });

                        if (activeAuto) {
                            const automation = await Automation.findById(activeAuto.automationId);
                            if (automation) {
                                const nextStageIndex = activeAuto.currentStageIndex + 1;
                                const nextStage = automation.stages.find(s => s.stageIndex === nextStageIndex);

                                if (nextStage) {
                                    console.log(`🎯 [MULTI-AUTO] Advancing to Stage ${nextStageIndex} for ${cleanPhone}`);

                                    let authKey = client.apiKey || INTERAKT_KEY;
                                    if (authKey && !authKey.includes(':') && !authKey.endsWith('=')) {
                                        authKey = Buffer.from(authKey + ':').toString('base64');
                                    }

                                    const payload = {
                                        fullPhoneNumber: cleanPhone,
                                        type: nextStage.message.mediaType || 'Text',
                                        data: nextStage.message.mediaType
                                            ? { mediaUrl: nextStage.message.mediaUrl, message: nextStage.message.text }
                                            : { message: nextStage.message.text }
                                    };

                                    await axios.post('https://api.interakt.ai/v1/public/message/', payload, {
                                        headers: { 'Authorization': `Basic ${authKey}`, 'Content-Type': 'application/json' }
                                    }).catch(e => console.error('❌ [STAGE-SEND ERROR]', e.message));

                                    await AutoState.findByIdAndUpdate(activeAuto._id || activeAuto.id, {
                                        currentStageIndex: nextStageIndex,
                                        nextReminderIndex: 0,
                                        lastInteractionAt: new Date(),
                                        nextReminderAt: (nextStage.reminders && nextStage.reminders.length > 0)
                                            ? new Date(Date.now() + (nextStage.reminders[0].delayHours * 3600000))
                                            : null,
                                        status: 'pending'
                                    });
                                } else {
                                    console.log(`✅ [MULTI-AUTO] Final stage reached for ${cleanPhone}. Marking completed.`);
                                    await AutoState.findByIdAndUpdate(activeAuto._id || activeAuto.id, {
                                        status: 'completed',
                                        lastInteractionAt: new Date()
                                    });
                                }
                                automationHandled = true;
                            }
                        }
                    }
                } catch (autoErr) { console.error('❌ [AUTO-CHECK ERROR]', autoErr.message); }

            if (automationHandled) {
                console.log(`⏭️ [GATE] Automation handled the reply. Skipping AI.`);
                return;
            }

            // Load Chat to check persistence state if memory is empty
            activeChat = activeChat || await Chat.findOne({ clientId, customerPhone });

            let state = lastBotMessages.get(key);
            if (!state && activeChat && activeChat.messages.length > 0) {
                const lastMsg = activeChat.messages[activeChat.messages.length - 1];
                state = { text: lastMsg.text, source: lastMsg.sender === 'customer' ? 'unknown' : lastMsg.sender };
            }

            const lastMsgText = state ? state.text : "";
            const lastMsgSource = state ? state.source : "unknown";

            console.log(`🤖 [GATE] Last: "${lastMsgText.substring(0, 30)}..." | Source: ${lastMsgSource}`);

            // --- LOGIC GATE: Persistent Handover Check (Dynamic Keywords) ---
            const now = new Date();
            const isPersistentActive = activeChat && activeChat.handoverActive && activeChat.handoverExpiresAt && new Date(activeChat.handoverExpiresAt) > now;

            if (!isPersistentActive) {
                const currentText = text.toLowerCase();
                const keywords = client.botTriggerKeywords || [];
                
                console.log(`🔍 [GATE] Checking triggers for Client: ${clientId}. Keywords: [${keywords.join(', ')}]`);

                let isTriggered = false;
                if (keywords.length > 0) {
                    isTriggered = keywords.some(k => currentText.includes(k.toLowerCase()));
                } else {
                    // Strictly wait for "ask anything" if no keywords are configured
                    isTriggered = currentText.includes('ask anything');
                }

                if (!isTriggered) {
                    console.log(`⏳ [GATE] No trigger match. Waiting for: [${keywords.length > 0 ? keywords.join(', ') : 'ask anything'}]`);
                    return;
                }

                console.log(`🚀 [GATE] Trigger detected! AI session started for 5 minutes.`);
                
                // Set Persistent State (5 Minute Timeout)
                if (activeChat) {
                    activeChat.handoverActive = true;
                    activeChat.handoverExpiresAt = new Date(Date.now() + (5 * 60000)); // 5 min timeout
                    await activeChat.save();
                }
            } else {
                console.log(`✅ [GATE] AI session active. Time remaining: ${Math.round((new Date(activeChat.handoverExpiresAt) - now) / 1000)}s`);
                // Extend the timeout on each user message (Keep it alive for another 5 mins)
                if (activeChat) {
                    activeChat.handoverExpiresAt = new Date(Date.now() + (5 * 60000));
                    await activeChat.save();
                }
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

                // --- AI PROCESSING (RAG BASED) ---

                const ragResponse = await rag.query(clientId, normalizedQuery, chatHistory, client.name, client.botRules);

                // CLEAN RESPONSE: Strict plain-text formatting for WhatsApp
                let response = ragResponse.text.trim();
                const imageUrl = ragResponse.imageUrl;
                console.timeEnd(`🔍 [RAG+AI] ${customerPhone}`);

                if (response || imageUrl) {
                    try {
                        console.log(`📡 [SENDING] Processing AI response for ${customerPhone}...`);

                        // 1. Send Text Reply
                        if (response) {
                            if (!customerPhone || customerPhone.length < 7) {
                                console.error(`❌ [SEND ERROR] Invalid phone number: ${customerPhone}. Skipping API call.`);
                                return;
                            }

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
                                        console.error(`⚠️ [INTERAKT ERROR] Text Attempt ${i + 1}:`, err.response?.data || err.message);
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
                                        console.error(`⚠️ [INTERAKT ERROR] Image Attempt ${i + 1}:`, err.response?.data || err.message);
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
        } finally {
            // Always release the lock
            inFlightRequests.delete(lockKey);
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

// --- AUTOMATION SYSTEM ---
// 1. Create/Update Automation Flow
// 4. Bot Training Config
app.get('/api/client/:id/bot-config', authenticateToken, async (req, res) => {
    try {
        const client = await Client.findById(req.params.id);
        if (!client) return res.status(404).json({ error: 'Client not found' });
        res.json({
            botRules: client.botRules || '',
            botTriggerKeywords: client.botTriggerKeywords || []
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/client/:id/bot-config', authenticateToken, async (req, res) => {
    try {
        const { botRules, botTriggerKeywords } = req.body;
        await Client.findByIdAndUpdate(req.params.id, {
            botRules,
            botTriggerKeywords
        });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/client/:id/automations', authenticateToken, async (req, res) => {
    try {
        const { name, stages } = req.body;
        const automation = new Automation({
            clientId: req.params.id,
            name,
            stages
        });
        await automation.save();
        res.json({ success: true, automationId: automation._id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Get Automations
app.get('/api/client/:id/automations', authenticateToken, async (req, res) => {
    try {
        const data = await Automation.find({ clientId: req.params.id });
        res.json(data.reverse());
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. Delete Automation
app.delete('/api/client/:id/automations/:autoId', authenticateToken, async (req, res) => {
    try {
        await Automation.findByIdAndDelete(req.params.autoId);
        await AutoState.deleteMany({ automationId: req.params.autoId });
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// --- CAMPAIGN & BULK MESSAGING SYSTEM ---
// 1. Get Scheduled Campaigns
app.get('/api/client/:id/scheduled-campaigns', authenticateToken, async (req, res) => {
    try {
        const data = await Campaign.find({ clientId: req.params.id });
        res.json(data.reverse());
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 2. Schedule a New Campaign
app.post('/api/client/:id/schedule-campaign', authenticateToken, async (req, res) => {
    try {
        const { name, message, contacts, mediaUrl, mediaType, fileName, scheduledAt, timezone } = req.body;
        const campaign = new Campaign({
            clientId: req.params.id,
            name,
            message,
            contacts,
            mediaUrl,
            mediaType,
            fileName,
            scheduledAt: new Date(scheduledAt),
            timezone: timezone || 'IST',
            status: 'scheduled',
            totalContacts: contacts.length
        });
        await campaign.save();
        res.json({ success: true, campaignId: campaign._id });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 3. Delete/Cancel Scheduled Campaign
app.delete('/api/client/:id/scheduled-campaigns/:campaignId', authenticateToken, async (req, res) => {
    try {
        await Campaign.findByIdAndDelete(req.params.campaignId);
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// 4. Real-time Bulk Sending with Streaming Progress
app.post('/api/client/:id/bulk-send-v2', authenticateToken, async (req, res) => {
    try {
        const { contacts, message, campaignName, automationId, mediaList } = req.body;
        const clientId = req.params.id;
        const client = await Client.findById(clientId);

        if (!client) return res.status(404).json({ error: 'Client not found' });

        // Set headers for streaming
        res.setHeader('Content-Type', 'text/event-stream');
        res.setHeader('Cache-Control', 'no-cache');
        res.setHeader('Connection', 'keep-alive');

        // Create a Campaign record for history
        const campaign = new Campaign({
            clientId,
            name: campaignName || 'Instant Campaign',
            message,
            contacts,
            status: 'sending',
            totalContacts: contacts.length,
            sentCount: 0,
            failedCount: 0,
            createdAt: new Date(),
            scheduledAt: new Date()
        });
        await campaign.save();

        let sent = 0;
        let failed = 0;

        // Start sending one by one
        for (let i = 0; i < contacts.length; i++) {
            let phone = contacts[i].replace(/\D/g, '');
            if (phone.length === 10) phone = '91' + phone;
            if (!phone.startsWith('+')) phone = '+' + phone;

            try {
                let authKey = client.apiKey || INTERAKT_KEY;
                if (authKey && !authKey.includes(':') && !authKey.endsWith('=')) {
                    authKey = Buffer.from(authKey + ':').toString('base64');
                }

                // Send to Interakt
                const payload = {
                    fullPhoneNumber: phone,
                    type: (mediaList && mediaList.length > 0) ? 'Image' : 'Text', // Simple logic for now
                    data: (mediaList && mediaList.length > 0) ? {
                        mediaUrl: mediaList[0].url,
                        message: message
                    } : { message: message }
                };

                await axios.post('https://api.interakt.ai/v1/public/message/', payload, {
                    headers: {
                        'Authorization': `Basic ${authKey}`,
                        'Content-Type': 'application/json'
                    }
                });

                sent++;
                
                // If automation is linked, register it
                if (automationId) {
                    const state = new AutoState({
                        clientId,
                        campaignId: campaign._id,
                        automationId,
                        customerPhone: phone,
                        status: 'pending',
                        currentStageIndex: 0,
                        nextReminderIndex: 0,
                        nextReminderAt: new Date(Date.now() + 60000) // Default start
                    });
                    await state.save();
                }

            } catch (err) {
                console.error(`❌ [BULK SEND] Failed for ${phone}:`, err.message);
                failed++;
            }

            // Stream progress back to frontend
            res.write(JSON.stringify({
                sent,
                failed,
                total: contacts.length,
                percent: Math.round(((i + 1) / contacts.length) * 100),
                done: i === contacts.length - 1
            }) + '\n');

            // Wait a bit to avoid rate limiting
            await new Promise(r => setTimeout(r, 800));
        }

        // Finalize Campaign Status
        campaign.status = 'sent';
        campaign.sentCount = sent;
        campaign.failedCount = failed;
        await campaign.save();

        res.end();
    } catch (err) {
        console.error('❌ [BULK V2 ERROR]', err);
        res.status(500).end();
    }
});

// 4. Update Webhook to handle "Replied" status
app.post('/webhook/interakt', async (req, res) => {
    // ... logic to handle incoming status updates
    // if status is 'replied', we find the AutoState by phone and update status to 'completed'
});

// 5. Advanced Background Processor (Reminders + Scheduling)
setInterval(async () => {
    try {
        const now = new Date();

        // A. Handle Scheduled Campaigns
        const pendingCampaigns = await Campaign.find({ status: 'scheduled', scheduledAt: { $lte: now } });
        for (let campaign of pendingCampaigns) {
            await Campaign.findByIdAndUpdate(campaign._id || campaign.id, { status: 'sending' });
            const client = await Client.findById(campaign.clientId);
            if (!client) continue;

            (async () => {
                let sent = 0;
                for (let contact of campaign.contacts) {
                    try {
                        let phone = contact.split(',')[0].replace(/\D/g, '');
                        if (phone.length === 10) phone = '91' + phone;

                        // Send Message
                        await axios.post('https://api.interakt.ai/v1/public/message/', {
                            fullPhoneNumber: phone,
                            type: campaign.mediaType || 'Text',
                            data: campaign.mediaType ? { mediaUrl: campaign.mediaUrl, message: campaign.message, fileName: campaign.fileName } : { message: campaign.message }
                        }, { headers: { 'Authorization': `Basic ${client.apiKey || INTERAKT_KEY}` } });

                        sent++;

                        // REGISTER AUTO STATE if campaign has automation
                        if (campaign.automationId) {
                            const automation = await Automation.findById(campaign.automationId);
                            let firstStageReminderAt = null;
                            
                            if (automation && automation.stages && automation.stages.length > 0) {
                                const firstStage = automation.stages[0];
                                if (firstStage.reminders && firstStage.reminders.length > 0) {
                                    const r = firstStage.reminders[0];
                                    // Support both fixedTime (calendar) and delayHours (relative)
                                    if (r.fixedTime) {
                                        firstStageReminderAt = new Date(r.fixedTime);
                                    } else if (r.delayHours) {
                                        firstStageReminderAt = new Date(Date.now() + (r.delayHours * 3600000));
                                    }
                                }
                            }

                            const state = new AutoState({
                                clientId: campaign.clientId,
                                campaignId: campaign._id || campaign.id,
                                automationId: campaign.automationId,
                                customerPhone: phone,
                                status: 'pending',
                                nextReminderAt: firstStageReminderAt
                            });
                            await state.save();
                        }
                    } catch (err) { }
                    await new Promise(r => setTimeout(r, 1000));
                }
                await Campaign.findByIdAndUpdate(campaign._id || campaign.id, { status: 'sent', sentCount: sent });
            })();
        }
        // B. Handle Automated Reminders (Multi-Stage)
        const pendingReminders = await AutoState.find({ status: 'pending', nextReminderAt: { $lte: now } });
        for (let state of pendingReminders) {
            try {
                // CRITICAL FIX: Check if AI Bot is currently active for this customer
                const chat = await Chat.findOne({ clientId: state.clientId, customerPhone: state.customerPhone });
                const isBotActive = chat && chat.handoverActive && chat.handoverExpiresAt && new Date(chat.handoverExpiresAt) > now;
                
                if (isBotActive) {
                    console.log(`🤖 [REMINDER SKIP] AI session active for ${state.customerPhone}. Delaying reminder.`);
                    // We don't delete it, just skip this cycle so it checks again later
                    continue;
                }

                const automation = await Automation.findById(state.automationId);
                const client = await Client.findById(state.clientId);
                if (!automation || !client || !automation.isActive) continue;

                // Get Current Stage
                const currentStage = automation.stages.find(s => s.stageIndex === state.currentStageIndex);
                if (!currentStage) continue;

                const reminder = currentStage.reminders[state.nextReminderIndex];
                if (reminder) {
                    console.log(`⏰ [REMINDER] Stage ${state.currentStageIndex} Step ${state.nextReminderIndex + 1} -> ${state.customerPhone}`);

                    let authKey = client.apiKey || INTERAKT_KEY;
                    if (authKey && !authKey.includes(':') && !authKey.endsWith('=')) {
                        authKey = Buffer.from(authKey + ':').toString('base64');
                    }

                    const reminderPayload = {
                        fullPhoneNumber: state.customerPhone,
                        type: reminder.mediaType || 'Text',
                        data: reminder.mediaType ? {
                            mediaUrl: reminder.mediaUrl,
                            message: reminder.message
                        } : { message: reminder.message }
                    };

                    await axios.post('https://api.interakt.ai/v1/public/message/', reminderPayload, {
                        headers: {
                            'Authorization': `Basic ${authKey}`,
                            'Content-Type': 'application/json'
                        }
                    });

                    // Update state for next step in SAME stage
                    const nextIndex = state.nextReminderIndex + 1;
                    const nextReminder = currentStage.reminders[nextIndex];

                    await AutoState.findByIdAndUpdate(state._id || state.id, {
                        nextReminderIndex: nextIndex,
                        nextReminderAt: nextReminder
                            ? (nextReminder.fixedTime
                                ? new Date(nextReminder.fixedTime)                          // calendar-based
                                : new Date(Date.now() + ((nextReminder.delayHours || 1) * 3600000))) // relative
                            : null,
                    });
                }
            } catch (err) { console.error(`❌ [REMINDER ERROR] ${state.customerPhone}:`, err.message); }
        }
    } catch (err) { console.error('❌ [AUTOMATION RUNNER ERROR]', err.message); }
}, 60000);

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
