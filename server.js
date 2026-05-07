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
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

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
            const sanitizedName = client.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
            const clientFolder = `${sanitizedName}_${client._id || client.id}`;
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
            name: client.name,
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
        res.json({
            ...client.toObject ? client.toObject() : client,
            id: client._id || client.id,
            documentCount: (client.documents || []).length
        });
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
        const sanitizedName = client.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const clientFolder = `${sanitizedName}_${clientId}`;
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

app.delete('/api/client/:id/documents/:filename', async (req, res) => {
    try {
        const client = await Client.findById(req.params.id);
        if (!client) return res.status(404).json({ error: 'Client not found' });

        const sanitizedName = client.name.replace(/[^a-z0-9]/gi, '_').toLowerCase();
        const clientFolder = `${sanitizedName}_${client._id || client.id}`;
        
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
        ticket.messages.push({ sender: 'client', text: message });
        ticket.lastUpdate = new Date();
        ticket.status = 'open';
        
        await ticket.save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
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
        let clients = await Client.find({});
        // Filter out admins manually for compatibility with JSON mock
        clients = clients.filter(c => c.role !== 'admin' && !c.isAdmin);
        
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
        const clients = await Client.find({});
        const approved = clients.filter(c => c.status === 'approved');
        const totalDocs = clients.reduce((acc, c) => acc + (c.documents || []).length, 0);
        res.json({
            totalClients: clients.length,
            pendingApprovals: clients.filter(c => c.status === 'pending').length,
            approvedClients: approved.length,
            totalDocs: totalDocs
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
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
            return res.sendStatus(200);
        }

        const message = body.data?.message;
        if (!message) {
            console.log('ℹ️ [WEBHOOK] No message object in payload');
            return res.sendStatus(200);
        }

        // 1. Extract and Normalize Data Immediately
        const text = (message.text || message.message || "").trim();
        const rawPhone = message.customer_number || body.data?.customer?.phone_number || "unknown";
        let customerPhone = rawPhone === "unknown" ? "unknown" : rawPhone.replace(/\D/g, '');
        if (customerPhone.length === 10) customerPhone = '91' + customerPhone;
        if (customerPhone !== "unknown" && !customerPhone.startsWith('+')) customerPhone = '+' + customerPhone;

        if (!text) return res.sendStatus(200);

        // --- ASYNC PROCESSING ---
        const messageId = message.id || "no-id";
        const lockKey = `${clientId}_${customerPhone}`;

        // Stop retries & duplicates
        if (processedMessageIds.has(messageId) || inFlightRequests.has(lockKey)) {
            console.log(`ℹ️ [WEBHOOK] Ignoring duplicate or in-flight message.`);
            return res.sendStatus(200);
        }

        // Send 200 OK immediately
        res.sendStatus(200);

        processedMessageIds.add(messageId);
        inFlightRequests.add(lockKey);
        if (processedMessageIds.size > 1000) processedMessageIds.delete(processedMessageIds.values().next().value);

        try {
            const client = await Client.findById(clientId);
            if (!client || !client.botEnabled) {
                console.log(`ℹ️ [WEBHOOK] Bot disabled or client not found for ${clientId}`);
                return;
            }

            let chat = await Chat.findOne({ clientId, customerPhone });
            if (!chat) {
                chat = new Chat({ clientId, customerPhone, messages: [], lastUpdate: new Date() });
            }
            
            // Deduplicate echo before processing
            if (chat.messages.length > 0) {
                const lastMsg = chat.messages[chat.messages.length - 1];
                if (lastMsg.sender === 'bot' && (text.startsWith(lastMsg.text.substring(0, 30)) || lastMsg.text.startsWith(text.substring(0, 30)))) {
                    return; 
                }
            }

            chat.messages.push({ sender: 'customer', text });
            chat.lastUpdate = new Date();
            await chat.save();

            if (openai && text !== "Media/Unsupported message") {
                const normalizedMsg = text.toLowerCase().trim();
                const greetingKeywords = ['hi', 'hello', 'hey', 'start', 'namaste', 'aslam', 'help', 'ji', 'hye', 'hy', 'hola'];
                const workflowOptions = ['1', '2', 'services', 'pricing', 'plans'];
                
                const isFirstMessage = chat.messages.filter(m => m.sender === 'customer').length <= 1;
                let response = "";

                // 1. Initial Greeting + Workflow (ALWAYS on first message)
                if (isFirstMessage || greetingKeywords.some(k => normalizedMsg.includes(k))) {
                    response = "Hello! 👋 Welcome to our business.\n\nI am your automated assistant. How can I help you today? Please choose an option or type any question:\n\n1️⃣ *About Services*\n2️⃣ *Pricing Plans*\n3️⃣ *Talk to AI Expert*";
                } 
                // 2. Workflow Option 1 (Services)
                else if (normalizedMsg === '1' || normalizedMsg.includes('service') || normalizedMsg.includes('about services')) {
                    response = "We provide premium *AI-powered WhatsApp automation*. 🚀 Our bots can handle customer support, sales, and document queries 24/7. Type any question to see me in action!";
                }
                // 3. Workflow Option 2 (Pricing)
                else if (normalizedMsg === '2' || normalizedMsg.includes('pricing') || normalizedMsg.includes('plan')) {
                    response = "Our subscription plans are flexible for every business. 📊 Please let me know your requirements, or ask me about specific features!";
                }
                // 4. Smart AI Fallback (For everything else, including Option 3)
                else {
                    console.log(`🧠 [AI ACTIVATE] Processing query: ${text}`);
                    response = await rag.query(clientId, text);
                }

                try {
                    await axios.post('https://api.interakt.ai/v1/public/message/', {
                        fullPhoneNumber: customerPhone,
                        type: 'Text',
                        data: {
                            message: response
                        }
                    }, {
                        headers: { 'Authorization': `Basic ${client.apiKey}` }
                    });

                    chat.messages.push({ sender: 'bot', text: response });
                    await chat.save();
                } catch (apiErr) {
                    console.error('❌ [WEBHOOK API ERROR]', apiErr.response?.data || apiErr.message);
                }
            }
        } catch (err) {
            console.error('❌ [WEBHOOK ERROR]', err.message);
        } finally {
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

// --- STARTUP ---
const { connectDB } = require('./database');

(async () => {
    try {
        // 1. Connect to DB first
        await connectDB();
        
        // 2. Start Server
        app.listen(PORT, '0.0.0.0', () => {
            console.log(`🚀 [BACKEND READY] Listening on 0.0.0.0:${PORT}`);
            
            // 3. Sync RAG in background with a safety delay
            if (openai) {
                setTimeout(() => {
                    syncKnowledgeBase()
                        .then(() => console.log('✅ [RAG] Knowledge Base Ready.'))
                        .catch(e => console.error('❌ [RAG ERROR]', e.message));
                }, 2000);
            }
        });
    } catch (err) {
        console.error('💥 [CRITICAL STARTUP ERROR]', err.message);
        process.exit(1);
    }
})();
