require('dotenv').config();
const express = require('express');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const multer = require('multer');
const cors = require('cors');
const mongoose = require('mongoose');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 8080;

// Initialize OpenAI and RAG
const { OpenAI } = require('openai');
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;

if (!openai) {
    console.error('⚠️ [CRITICAL] OPENAI_API_KEY is missing in environment variables!');
}

const SimpleRAG = require('./rag');
const rag = new SimpleRAG(openai);
const gcs = require('./gcs'); // Added GCP Storage utility

// Initialize RAG (Sync from GCS and Index for all clients)
async function syncKnowledgeBase() {
    console.log('🔄 [RAG] Syncing files from GCS and knowledge_base folder...');
    const clients = await Client.find({});
    const kbRoot = path.join(__dirname, 'knowledge_base');

    if (!fs.existsSync(kbRoot)) fs.mkdirSync(kbRoot, { recursive: true });

    for (const client of clients) {
        const clientId = client._id.toString();
        const clientKbDir = path.join(kbRoot, clientId);
        if (!fs.existsSync(clientKbDir)) fs.mkdirSync(clientKbDir, { recursive: true });

        // Sync from GCS to local if local files are missing
        if (gcs.isGcsActive) {
            try {
                const cloudFiles = await gcs.listClientFiles(clientId);
                for (const file of cloudFiles) {
                    const localFilePath = path.join(clientKbDir, file);
                    if (!fs.existsSync(localFilePath)) {
                        await gcs.downloadFromBucket(clientId, file, localFilePath);
                    }
                }
            } catch (err) {
                console.error(`❌ [GCS] Sync failed for client ${clientId}:`, err.message);
            }
        }
        
        // Check if there are files in the root knowledge_base to sync to this client
        const rootFiles = fs.readdirSync(kbRoot).filter(f => fs.lstatSync(path.join(kbRoot, f)).isFile());
        for (const file of rootFiles) {
            const dest = path.join(clientKbDir, file);
            if (!fs.existsSync(dest)) {
                fs.copyFileSync(path.join(kbRoot, file), dest);
                console.log(`✅ [RAG] Synced root file ${file} for client ${client.name}`);
            }
        }
    }
    
    // Now initialize RAG (it will load all files from local folders)
    if (openai) {
        try {
            await rag.init();
        } catch (err) {
            console.error('❌ [RAG] Initialization failed:', err.message);
        }
    } else {
        console.warn('⚠️ [RAG] OpenAI Key missing. RAG will be inactive.');
    }
}
// Removed early call from here to fix ReferenceError

app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    credentials: true
}));
app.options('*', cors()); // Enable pre-flight for all routes

app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- ERROR HANDLING ---
process.on('uncaughtException', (err) => {
    console.error('💥 Uncaught Exception:', err);
});
process.on('unhandledRejection', (reason, promise) => {
    console.error('💥 Unhandled Rejection at:', promise, 'reason:', reason);
});
process.on('exit', (code) => {
    console.log(`👋 Process exited with code: ${code}`);
});

// Keep-alive to prevent premature exit
setInterval(() => {}, 10000);

const { Client, Ticket, Chat, OTP, isLocal } = require('./database');

// --- EMAIL TRANSPORTER ---
const transporter = nodemailer.createTransport({
    service: 'gmail', // Use 'service' shorthand for Gmail
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    },
    tls: {
        rejectUnauthorized: false
    }
});

// Verify transporter
transporter.verify((error, success) => {
    if (error) {
        console.error('❌ Email Transporter Error:', error);
        console.log('--- TIPS FOR LIVE DEPLOYMENT ---');
        console.log('1. Ensure EMAIL_USER and EMAIL_PASS are set in Render environment variables.');
        console.log('2. If using Gmail, use an "App Password" not your regular password.');
        console.log('3. Disable 2FA or use App Passwords if 2FA is on.');
    } else {
        console.log('✅ Email Transporter is ready and connected');
    }
});

// Models are now imported from ./database.js

// --- HEALTH CHECK ---
app.get('/ping', (req, res) => {
    res.json({ status: 'Alive', mode: isLocal ? 'Local (JSON)' : 'Live (MongoDB)' });
});

// --- AUTH API ---

app.get('/api/rag-status', (req, res) => {
    const status = {
        clients: Object.keys(rag.clientChunks).length,
        details: {}
    };
    for (const id in rag.clientChunks) {
        status.details[id] = rag.clientChunks[id].length + " chunks";
    }
    res.json(status);
});

app.post('/api/auth/send-otp', async (req, res) => {
    const { email } = req.body;
    const otp = Math.floor(100000 + Math.random() * 900000).toString();
    
    // Save OTP to MongoDB (Upsert)
    await OTP.findOneAndUpdate({ email }, { otp, createdAt: new Date() }, { upsert: true });

    const mailOptions = {
        from: process.env.EMAIL_USER,
        to: email,
        subject: 'Your Verification Code - Whatsabot',
        text: `Your OTP for registration is: ${otp}. This code is valid for 10 minutes.`,
        html: `
            <div style="font-family: Arial, sans-serif; padding: 20px; color: #333;">
                <h2 style="color: #6366f1;">Welcome to Whatsabot!</h2>
                <p>Use the following code to complete your registration:</p>
                <div style="background: #f3f4f6; padding: 15px; border-radius: 8px; font-size: 24px; font-weight: bold; letter-spacing: 5px; text-align: center; margin: 20px 0;">
                    ${otp}
                </div>
                <p style="font-size: 0.875rem; color: #666;">If you didn't request this, please ignore this email.</p>
            </div>
        `
    };

    try {
        console.log(`📩 Received OTP request for: ${email}`);
        
        if (isLocal) {
            console.log(`\n-----------------------------------------`);
            console.log(`[LOCAL MODE] OTP for ${email} is: ${otp}`);
            console.log(`-----------------------------------------\n`);
            return res.json({ success: true, message: 'OTP logged to console (Local Mode)' });
        }

        console.log(`Attempting to send OTP via email to ${email}...`);
        await transporter.sendMail(mailOptions);
        console.log(`✅ OTP successfully sent to ${email}`);
        res.json({ success: true });
    } catch (err) {
        console.error('❌ Error in /api/auth/send-otp:', err);
        res.status(500).json({ 
            error: 'Failed to send email.', 
            details: err.message,
            suggestion: 'Check your EMAIL_USER and EMAIL_PASS. Ensure you are using an App Password.' 
        });
    }
});

app.post('/api/auth/register', async (req, res) => {
    const { name, email, password, otp } = req.body;
    const otpDoc = await OTP.findOne({ email, otp });

    if (!otpDoc) {
        return res.status(400).json({ error: 'Invalid or expired OTP' });
    }

    try {
        const client = isLocal ? Client.new({ name, email, password }) : new Client({ name, email, password });
        await client.save();
        await OTP.deleteOne({ email }); // Clear OTP after success

        // Auto-initialize GCS folder for new client
        if (gcs.isGcsActive) {
            await gcs.uploadToBucket(client._id.toString(), '.keep', Buffer.from('folder initialization'));
            console.log(`📂 [GCS] Initialized folder for new client: ${name}`);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: 'Email already exists' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    
    if (email === 'admin@uwo24.com' && password === 'Admin@24') {
        return res.json({ id: 'admin_id', name: 'Master Admin', role: 'admin' });
    }

    const client = await Client.findOne({ email, password });
    if (client) {
        if (client.status !== 'approved') return res.status(403).json({ error: 'Account pending approval' });
        res.json({ id: client._id, name: client.name, role: 'client' });
    } else {
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

// --- CLIENT API ---

app.get('/api/client/:id', async (req, res) => {
    try {
        const client = await Client.findById(req.params.id);
        res.json(client);
    } catch (err) {
        res.status(404).json({ error: 'Client not found' });
    }
});

app.post('/api/client/:id/config', async (req, res) => {
    const { whatsappNumber, apiKey } = req.body;
    try {
        await Client.findByIdAndUpdate(req.params.id, { whatsappNumber, apiKey });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Update failed' });
    }
});

app.post('/api/client/:id/toggle-bot', async (req, res) => {
    const { enabled } = req.body;
    try {
        await Client.findByIdAndUpdate(req.params.id, { botEnabled: enabled });
        res.json({ success: true });
    } catch (err) {
        res.status(500).json({ error: 'Toggle failed' });
    }
});

// --- CHATS & WEBHOOK ---

app.get('/api/client/:id/chats', async (req, res) => {
    const chats = await Chat.find({ clientId: req.params.id });
    const formatted = {};
    chats.forEach(c => {
        formatted[c.customerPhone] = c.messages;
    });
    res.json(formatted);
});

async function saveChatMessage(clientId, customerPhone, sender, text) {
    let chat = await Chat.findOne({ clientId, customerPhone });
    if (!chat) {
        const chatData = { clientId, customerPhone, messages: [], lastUpdate: Date.now() };
        chat = isLocal ? Chat.new(chatData) : new Chat(chatData);
    }
    chat.messages.push({ sender, text });
    chat.lastUpdate = Date.now();
    await chat.save();
}

app.post('/webhook/interakt/:clientId', async (req, res) => {
    const { clientId } = req.params;
    const data = req.body.data;
    
    console.log(`\n--- 📥 Incoming Webhook for Client: ${clientId} ---`);
    console.log('Payload Data:', JSON.stringify(data, null, 2));

    try {
        const client = await Client.findById(clientId);
        if (!client) {
            console.log(`❌ Client ${clientId} not found in database.`);
            return res.sendStatus(200);
        }

        // Check if message is from customer (ignore outgoing agent/bot messages)
        const chatMessageType = data.chat_message_type || (data.message && data.message.chat_message_type);
        if (chatMessageType && chatMessageType !== 'CustomerMessage') {
            console.log(`🚫 Ignoring ${chatMessageType} to prevent infinite loop.`);
            return res.sendStatus(200);
        }

        if (!client.botEnabled) {
            console.log(`⏸️ Bot is disabled for client: ${client.name}`);
            return res.sendStatus(200);
        }

        // Deep check for Interakt payload format (handling nested fields found in logs)
        const messageType = data.message_content_type || (data.message && (data.message.message_content_type || data.message.type));
        const incomingMessage = (typeof data.message === 'string' ? data.message : (data.message && (data.message.message || data.message.textContent)));

        if (messageType === 'Text' && incomingMessage) {
            let senderPhone = null;
            if (data.customer) {
                // Use channel_phone_number and ensure it has '+'
                const rawPhone = data.customer.channel_phone_number || data.customer.phone_number;
                if (rawPhone) {
                    senderPhone = rawPhone.startsWith('+') ? rawPhone : '+' + rawPhone;
                }
            }

            if (senderPhone) {
                console.log(`💬 Message from ${senderPhone}: "${incomingMessage}"`);
                
                await saveChatMessage(clientId, senderPhone, 'customer', incomingMessage);
                
                console.log(`🤖 Requesting AI response for: "${incomingMessage}"...`);
                const replyText = await getAIResponse(clientId, incomingMessage, client.autoReplyRules);
                console.log(`✨ AI Reply: "${replyText}"`);
                
                await saveChatMessage(clientId, senderPhone, 'bot', replyText);
                await sendWhatsAppMessage(senderPhone, replyText, client.apiKey);
            }
        } else {
            console.log('ℹ️ Webhook received but it is not a text message or format is different.');
            console.log('Detected Type:', messageType);
            console.log('Detected Content:', incomingMessage);
        }
    } catch (err) { 
        console.error('💥 Webhook Error:', err); 
    }
    res.sendStatus(200);
});

// --- ADMIN API ---

app.get('/api/admin/stats', async (req, res) => {
    try {
        const clients = await Client.find();
        const tickets = await Ticket.find({ status: 'open' });
        
        const totalClients = clients.length;
        const totalDocs = clients.reduce((sum, c) => sum + (c.documents ? c.documents.length : 0), 0);
        const pendingApprovals = clients.filter(c => c.status === 'pending').length;
        const approvedClients = clients.filter(c => c.status === 'approved').length;

        res.json({
            totalClients,
            totalDocs,
            pendingApprovals,
            approvedClients
        });
    } catch (err) {
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

app.get('/api/admin/clients', async (req, res) => {
    const clients = await Client.find();
    res.json(clients.map(c => ({
        id: c._id,
        name: c.name,
        email: c.email,
        username: c.email, // Use email as username for display
        status: c.status,
        whatsappNumber: c.whatsappNumber,
        documentCount: c.documents ? c.documents.length : 0,
        createdAt: c.createdAt,
        logoUrl: c.logoUrl,
        isBotActive: c.botEnabled
    })));
});

app.post('/api/admin/clients/create', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const client = isLocal ? Client.new({ name, email, password, status: 'approved' }) : new Client({ name, email, password, status: 'approved' });
        await client.save();

        // Auto-initialize GCS folder for new client
        if (gcs.isGcsActive) {
            await gcs.uploadToBucket(client._id.toString(), '.keep', Buffer.from('folder initialization'));
            console.log(`📂 [GCS] Initialized folder for admin-created client: ${name}`);
        }

        res.json({ success: true });
    } catch (err) {
        res.status(400).json({ error: 'Email already exists or invalid data' });
    }
});

app.post('/api/admin/clients/:id/approve', async (req, res) => {
    await Client.findByIdAndUpdate(req.params.id, { status: 'approved' });
    res.json({ success: true });
});

app.delete('/api/admin/clients/:id', async (req, res) => {
    await Client.findByIdAndDelete(req.params.id);
    res.json({ success: true });
});

// --- SUPPORT API ---

app.post('/api/support/send', async (req, res) => {
    const { clientId, clientName, message } = req.body;
    let ticket = await Ticket.findOne({ clientId, status: 'open' });
    if (!ticket) {
        const ticketData = { clientId, clientName, messages: [], lastUpdate: Date.now() };
        ticket = isLocal ? Ticket.new(ticketData) : new Ticket(ticketData);
    }
    ticket.messages.push({ sender: 'client', text: message });
    ticket.lastUpdate = Date.now();
    await ticket.save();
    res.json({ success: true });
});

app.get('/api/client/:id/support', async (req, res) => {
    const ticket = await Ticket.findOne({ clientId: req.params.id, status: 'open' });
    res.json(ticket || { messages: [] });
});

app.get('/api/admin/support/tickets', async (req, res) => {
    const tickets = await Ticket.find({ status: 'open' });
    res.json(tickets);
});

app.post('/api/admin/support/reply', async (req, res) => {
    const { ticketId, message } = req.body;
    try {
        const ticket = await Ticket.findById(ticketId);
        if (ticket) {
            ticket.messages.push({ sender: 'admin', text: message });
            ticket.lastUpdate = Date.now();
            await ticket.save();
            res.json({ success: true });
        } else {
            res.status(404).json({ error: 'Ticket not found' });
        }
    } catch (err) {
        res.status(500).json({ error: 'Server error' });
    }
});

app.post('/api/support/reply', async (req, res) => {
    const { clientId, text } = req.body;
    const ticket = await Ticket.findOne({ clientId, status: 'open' });
    if (ticket) {
        ticket.messages.push({ sender: 'admin', text });
        ticket.lastUpdate = Date.now();
        await ticket.save();
        res.json({ success: true });
    } else {
        res.status(404).json({ error: 'Ticket not found' });
    }
});

app.delete('/api/support/tickets/:clientId', async (req, res) => {
    await Ticket.deleteOne({ clientId: req.params.clientId });
    res.json({ success: true });
});

// --- AI LOGIC ---

async function getAIResponse(clientId, message, rules) {
    try {
        console.log(`🔍 [RAG] Searching knowledge base for Client: ${clientId}...`);
        const context = await rag.search(clientId, message);
        
        if (context) {
            console.log(`📄 [RAG] Found relevant context in documents.`);
        } else {
            console.log(`⚠️ [RAG] No relevant context found in documents.`);
        }

        const systemPrompt = `You are a professional, friendly, and highly efficient WhatsApp customer support assistant. 

Your specific brand guidelines/rules: ${rules || 'Be helpful and polite.'}

TONE & STYLE:
- *Premium & Helpful*: Sound like a well-trained assistant.
- *Language*: Respond in the SAME LANGUAGE/TONE as the user (e.g., if they use Hinglish, you respond in Hinglish; if Hindi, respond in Hindi).
- *Concise*: WhatsApp users prefer quick, readable answers.

FORMATTING RULES (CRITICAL for WhatsApp):
1. *Bold Header*: Use *bold text* for headers or key emphasis (Example: *Our Catalog*).
2. *Lists*: Use clear bullet points (•) or numbered lists for multiple options/steps.
3. *Emojis*: Use 1-2 relevant emojis per message to keep it friendly but professional (e.g., 👋, ✅, 📍, 📞).
4. *Spacing*: Use double line breaks between different sections of your answer.
5. *No Markdown*: DO NOT use # headers, --- lines, or backticks. Only use * for bold.

HOW TO ANSWER:
1. *Knowledge Base*: Use the "Relevant information" below as your primary source.
2. *Accuracy*: If the answer is in the documents, stick to them strictly.
3. *Fallback*: If info is NOT in documents, use your general knowledge but maintain the professional tone.
4. *Escalation*: If you cannot help, politely suggest waiting for a human agent.

Relevant information from our documents:
${context || 'No specific documents found for this query.'}
`;

        const response = await openai.chat.completions.create({
            model: 'gpt-4o-mini', // Superior for following formatting instructions
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: message }
            ]
        });
        return response.choices[0].message.content;
    } catch (err) {
        console.error('❌ AI Response Error:', err.message);
        return "I am currently processing your request. Please wait.";
    }
}

async function sendWhatsAppMessage(phone, text, apiKey) {
    console.log(`📤 Attempting to send WhatsApp message to ${phone}...`);
    try {
        const response = await axios.post('https://api.interakt.ai/v1/public/message/', {
            fullPhoneNumber: phone,
            type: 'Text',
            data: {
                message: text // Interakt requires 'message' field inside 'data'
            }
        }, {
            headers: { 'Authorization': `Basic ${apiKey}` }
        });
        console.log(`✅ WhatsApp Message Sent! Interakt Response:`, response.data);
    } catch (err) { 
        console.error('❌ Error sending WhatsApp via Interakt:');
        if (err.response) {
            console.error('Status:', err.response.status);
            console.error('Data:', JSON.stringify(err.response.data, null, 2));
            if (err.response.status === 402) {
                console.error('💡 TIP: This status code usually means Insufficient Balance in Interakt.');
            }
        } else {
            console.error('Error Message:', err.message);
        }
    }
}

// --- FILE UPLOADS ---

const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const clientId = req.params.id;
        const dir = path.join(__dirname, 'uploads', clientId);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, Date.now() + '-' + file.originalname);
    }
});

const upload = multer({ storage });
app.post('/api/client/:id/upload', upload.single('file'), async (req, res) => {
    const { id } = req.params;
    const client = await Client.findById(id);
    if (!client) return res.status(404).json({ error: 'Client not found' });
    
    const filename = req.file.filename;
    client.documents.push(filename);
    await client.save();

    // Sync with RAG: Copy file to knowledge_base directory
    const kbDir = path.join(__dirname, 'knowledge_base', id);
    if (!fs.existsSync(kbDir)) fs.mkdirSync(kbDir, { recursive: true });
    fs.copyFileSync(req.file.path, path.join(kbDir, filename));
    
    // Sync with Google Cloud Storage (if active)
    await gcs.uploadToBucket(id, filename, req.file.path);
    
    // Re-index RAG for this client
    await rag.loadClientKnowledge(id);
    
    res.json({ success: true });
});

app.delete('/api/client/:id/documents/:filename', async (req, res) => {
    const { id, filename } = req.params;
    const client = await Client.findById(id);
    if (!client) return res.status(404).json({ error: 'Client not found' });

    client.documents = client.documents.filter(d => d !== filename);
    await client.save();
    
    // Delete from uploads
    const uploadPath = path.join(__dirname, 'uploads', id, filename);
    if (fs.existsSync(uploadPath)) fs.unlinkSync(uploadPath);

    // Delete from knowledge_base and re-index
    await rag.deleteFile(id, filename);
    
    // Delete from Google Cloud Storage (if active)
    await gcs.deleteFromBucket(id, filename);
    
    res.json({ success: true });
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`✅ [SUCCESS] Server is booting up...`);
    console.log(`🌐 Listening on: 0.0.0.0:${PORT}`);
    
    // DELAYED SYNC: This ensures Cloud Run sees the server as HEALTHY immediately
    // before the potentially heavy indexing process starts.
    setTimeout(() => {
        console.log('🔄 [ASYNC] Starting Knowledge Base sync in background...');
        syncKnowledgeBase().catch(err => {
            console.error('❌ [SYNC ERROR] Background sync failed:', err.message);
        });
    }, 5000); 
});
