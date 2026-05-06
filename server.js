require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const axios = require('axios');

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
            const clientId = client._id ? client._id.toString() : client.id;
            const clientKbDir = path.join(kbRoot, clientId);
            if (!fs.existsSync(clientKbDir)) fs.mkdirSync(clientKbDir, { recursive: true });

            if (gcs.isGcsActive) {
                const cloudFiles = await gcs.listClientFiles(clientId);
                for (const file of cloudFiles) {
                    const localFilePath = path.join(clientKbDir, file);
                    if (!fs.existsSync(localFilePath)) await gcs.downloadFromBucket(clientId, file, localFilePath);
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
    try {
        const client = await Client.findOne({ email, password });
        if (!client) return res.status(401).json({ error: 'Invalid credentials' });
        if (client.status !== 'approved' && !client.isAdmin) return res.status(403).json({ error: 'Account pending approval' });
        res.json({ success: true, clientId: client._id || client.id, clientName: client.name, isAdmin: client.isAdmin });
    } catch (err) { res.status(500).json({ error: err.message }); }
});


app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    try {
        await OTP.deleteOne({ email });
        const newOtp = OTP.new ? OTP.new({ email, otp }) : new OTP({ email, otp });
        await newOtp.save();
        console.log(`[OTP] Sent to ${email}: ${otp}`);
        res.json({ success: true, message: 'OTP sent' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/register', async (req, res) => {
    const { name, email, password, otp } = req.body;
    try {
        const validOtp = await OTP.findOne({ email, otp });
        if (!validOtp) return res.status(400).json({ error: 'Invalid or expired OTP' });

        const existing = await Client.findOne({ email });
        if (existing) return res.status(400).json({ error: 'Email already registered' });

        const client = Client.new ? Client.new({ name, email, password }) : new Client({ name, email, password });
        await client.save();
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

app.post('/api/client/:id/upload', upload.single('file'), async (req, res) => {
    try {
        const client = await Client.findById(req.params.id);
        const fileName = req.file.filename;
        const docs = client.documents || [];
        docs.push(fileName);

        await Client.findByIdAndUpdate(req.params.id, { documents: docs });

        const clientId = req.params.id;
        const clientKbDir = path.join(__dirname, 'knowledge_base', clientId);
        if (!fs.existsSync(clientKbDir)) fs.mkdirSync(clientKbDir, { recursive: true });
        fs.copyFileSync(req.file.path, path.join(clientKbDir, fileName));

        if (gcs.isGcsActive) {
            await gcs.uploadToBucket(clientId, fileName, req.file.path);
        }

        if (openai) await rag.init();
        res.json({ success: true, fileName });
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
        const chats = await Chat.find({ clientId: req.params.clientId });
        const chatMap = {};
        chats.forEach(c => {
            chatMap[c.customerPhone] = c.messages;
        });
        res.json(chatMap);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/api/client/:id/documents/:filename', async (req, res) => {
    try {
        const client = await Client.findById(req.params.id);
        const docs = (client.documents || []).filter(d => d !== req.params.filename);
        await Client.findByIdAndUpdate(req.params.id, { documents: docs });

        const localPath = path.join(__dirname, 'knowledge_base', req.params.id, req.params.filename);
        if (fs.existsSync(localPath)) fs.unlinkSync(localPath);

        if (gcs.isGcsActive) await gcs.deleteFromBucket(req.params.id, req.params.filename);
        if (openai) await rag.init();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
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

        const client = Client.new ? Client.new({ 
            name, 
            email, 
            password, 
            status: 'approved' // Admin created clients are pre-approved
        }) : new Client({ 
            name, 
            email, 
            password, 
            status: 'approved' 
        });
        await client.save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/clients', async (req, res) => {
    try {
        const clients = await Client.find({ role: { $ne: 'admin' } });
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

        console.log(`📡 [WEBHOOK] Processing for ${client.name}. Bot Enabled: ${client.botEnabled}`);
        if (!client.botEnabled) return res.sendStatus(200);

        const message = body.data?.message;
        if (!message) {
            console.log('ℹ️ [WEBHOOK] No message object in payload');
            return res.sendStatus(200);
        }

        if (message.from_me) return res.sendStatus(200);

        const rawPhone = message.customer_number || body.data?.customer?.phone_number || "unknown";
        let customerPhone = rawPhone === "unknown" ? "unknown" : rawPhone.replace(/\D/g, '');

        // Normalize: if 10 digits, assume India and add 91. 
        if (customerPhone.length === 10) customerPhone = '91' + customerPhone;
        // Always ensure '+' prefix for consistency in DB and Dashboard
        if (customerPhone !== "unknown" && !customerPhone.startsWith('+')) {
            customerPhone = '+' + customerPhone;
        }
        const text = message.text || message.message || "Media/Unsupported message";

        console.log(`💬 [WEBHOOK] From: ${customerPhone} | Text: ${text}`);

        if (customerPhone === "unknown") {
            console.log('⚠️ [WEBHOOK] Skipping: No customer phone found');
            return res.sendStatus(200);
        }

        // 1. Log customer message
        let chat = await Chat.findOne({ clientId, customerPhone });
        if (!chat) {
            chat = Chat.new ? Chat.new({ clientId, customerPhone }) : new Chat({ clientId, customerPhone });
        }
        chat.messages.push({ sender: 'customer', text });
        chat.lastUpdate = new Date();
        await chat.save();

        // 2. Get AI Response
        if (openai && text !== "Media/Unsupported message") {
            console.log('🤖 [WEBHOOK] Calling RAG Query...');
            const response = await rag.query(clientId, text);
            console.log(`✨ [WEBHOOK] AI Response generated: "${response.substring(0, 30)}..."`);

            // 3. Send response via Interakt API
            try {
                console.log('📤 [WEBHOOK] Sending to Interakt API...');

                const formattedPhone = customerPhone;

                console.log(`📱 [WEBHOOK] Target Phone: ${formattedPhone}`);

                // Try with the structure that got past the "data is required" check
                const interaktRes = await axios.post('https://api.interakt.ai/v1/public/message/', {
                    data: {
                        full_phone_number: formattedPhone,
                        type: 'text', // Try lowercase
                        message: response
                    }
                }, {
                    headers: { 'Authorization': `Basic ${client.apiKey}` }
                });
                console.log('✅ [WEBHOOK] Interakt Response:', interaktRes.status);

                // 4. Log bot message
                chat.messages.push({ sender: 'bot', text: response });
                await chat.save();
            } catch (apiErr) {
                console.error('❌ [WEBHOOK API ERROR]', apiErr.response?.data || apiErr.message);

                // Final fallback attempt with the other common structure
                if (apiErr.response?.status === 400) {
                    console.log('🔄 [WEBHOOK] Retrying with flat structure...');
                    try {
                        const formattedPhone = customerPhone;

                        await axios.post('https://api.interakt.ai/v1/public/message/', {
                            full_phone_number: formattedPhone,
                            type: 'Text',
                            message: response
                        }, {
                            headers: { 'Authorization': `Basic ${client.apiKey}` }
                        });
                        console.log('✅ [WEBHOOK] Interakt Flat Retry Success');
                        chat.messages.push({ sender: 'bot', text: response });
                        await chat.save();
                    } catch (err2) {
                        console.error('❌ [WEBHOOK] All send attempts failed.');
                    }
                }
            }
        } else {
            console.log(`⚠️ [WEBHOOK] AI skipped. OpenAI Ready: ${!!openai} | Text valid: ${text !== "Media/Unsupported message"}`);
        }

        res.sendStatus(200);
    } catch (err) {
        console.error('💥 [WEBHOOK CRITICAL ERROR]', err.message);
        res.sendStatus(200);
    }
});

// START SERVER
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 [BACKEND READY] Listening on 0.0.0.0:${PORT}`);

    // Background Init
    setTimeout(() => {
        syncKnowledgeBase().catch(e => console.error('Background Error:', e));
    }, 2000);
});
