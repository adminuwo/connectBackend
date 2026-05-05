require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 8080;

// Initialize OpenAI and RAG (Moved to after listen for stability)
const { OpenAI } = require('openai');
const openai = process.env.OPENAI_API_KEY ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY }) : null;
const SimpleRAG = require('./rag');
const rag = new SimpleRAG(openai);
const gcs = require('./gcs'); 

// Import database after env is ready
const { Client, Ticket, Chat, OTP, isLocal } = require('./database');

// CORS configuration
app.use(cors({
    origin: '*', 
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Requested-With', 'Accept'],
    credentials: true
}));
app.options('*', cors());

app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// --- SYNC LOGIC ---
async function syncKnowledgeBase() {
    console.log('🔄 [RAG] Syncing Knowledge Base...');
    try {
        const clients = await Client.find({});
        const kbRoot = path.join(__dirname, 'knowledge_base');
        if (!fs.existsSync(kbRoot)) fs.mkdirSync(kbRoot, { recursive: true });

        for (const client of clients) {
            const clientId = client._id.toString();
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

// --- ROUTES ---
// (Keeping your existing routes below...)
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Auth Routes
app.post('/api/auth/register', async (req, res) => {
    const { name, email, password } = req.body;
    try {
        const existing = await Client.findOne({ email });
        if (existing) return res.status(400).json({ error: 'Email already registered' });
        const otp = Math.floor(100000 + Math.random() * 900000).toString();
        const client = new Client({ name, email, password, otp, status: 'pending' });
        await client.save();
        res.json({ success: true, message: 'Registration pending approval' });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/auth/login', async (req, res) => {
    const { email, password } = req.body;
    try {
        const client = await Client.findOne({ email, password });
        if (!client) return res.status(401).json({ error: 'Invalid credentials' });
        if (client.status !== 'approved') return res.status(403).json({ error: 'Account pending approval' });
        res.json({ success: true, clientId: client._id, clientName: client.name, isAdmin: client.isAdmin });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin Stats
app.get('/api/admin/stats', async (req, res) => {
    try {
        const clients = await Client.find({});
        const approved = clients.filter(c => c.status === 'approved');
        res.json({
            totalClients: clients.length,
            totalDocs: clients.reduce((acc, c) => acc + (c.documents ? c.documents.length : 0), 0),
            pendingApprovals: clients.filter(c => c.status === 'pending').length,
            approvedClients: approved.length
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Client Dashboard Data
app.get('/api/client/:id', async (req, res) => {
    try {
        const client = await Client.findById(req.params.id);
        if (!client) return res.status(404).json({ error: 'Client not found' });
        res.json({
            name: client.name,
            whatsappNumber: client.whatsappNumber,
            apiKey: client.apiKey,
            botEnabled: client.botEnabled,
            status: client.status,
            documents: client.documents || [],
            logoUrl: client.logoUrl
        });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// Support Ticket Routes
app.get('/api/admin/support/tickets', async (req, res) => {
    try {
        const tickets = await Ticket.find({}).sort({ lastUpdate: -1 });
        res.json(tickets);
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/support/send', async (req, res) => {
    const { clientId, clientName, message } = req.body;
    try {
        let ticket = await Ticket.findOne({ id: clientId });
        if (!ticket) {
            ticket = new Ticket({ id: clientId, clientName, messages: [] });
        }
        ticket.messages.push({ sender: 'client', text: message, timestamp: new Date() });
        ticket.lastUpdate = new Date();
        await ticket.save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/api/admin/support/reply', async (req, res) => {
    const { ticketId, message } = req.body;
    try {
        const ticket = await Ticket.findOne({ id: ticketId });
        if (!ticket) return res.status(404).json({ error: 'Ticket not found' });
        ticket.messages.push({ sender: 'admin', text: message, timestamp: new Date() });
        ticket.lastUpdate = new Date();
        await ticket.save();
        res.json({ success: true });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// WhatsApp Bot Webhook (Interakt)
app.post('/webhook/interakt/:clientId', async (req, res) => {
    const { clientId } = req.params;
    const { customer, message } = req.body;
    console.log(`📩 [Webhook] Message from ${customer.phone}: ${message.text}`);
    
    try {
        const client = await Client.findById(clientId);
        if (!client || !client.botEnabled) return res.sendStatus(200);

        // Get context from RAG
        const context = await rag.search(clientId, message.text);
        
        // Generate AI Answer (Simplified for demonstration)
        const responseText = `Hi ${customer.name}, thanks for reaching out. Based on our data: ${context || 'We will get back to you.'}`;
        
        // Save to chat history
        let chat = await Chat.findOne({ clientId, phone: customer.phone });
        if (!chat) chat = new Chat({ clientId, phone: customer.phone, messages: [] });
        chat.messages.push({ sender: 'customer', text: message.text, timestamp: new Date() });
        chat.messages.push({ sender: 'bot', text: responseText, timestamp: new Date() });
        await chat.save();

        res.json({ success: true });
    } catch (err) {
        console.error('❌ Webhook error:', err.message);
        res.sendStatus(200);
    }
});

// START SERVER
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 [HEALTHY] Server is running on port ${PORT}`);
    
    // Background tasks (Non-blocking)
    setTimeout(() => {
        syncKnowledgeBase().catch(e => console.error('Background Sync Error:', e));
    }, 1000);
});
