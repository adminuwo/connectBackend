require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const fs = require('fs');

const app = express();
// Priority: process.env.PORT -> .env PORT -> 8080
const PORT = process.env.PORT || 8080;

// Super Defensive Environment Variable Check (Handling API/APT confusion)
const OPENAI_KEY = process.env.OPENAI_API_KEY || process.env.OPENAI_APT_KEY;
const INTERAKT_KEY = process.env.INTERAKT_API_KEY || process.env.INTERAKT_APT_KEY;

const { OpenAI } = require('openai');
const openai = OPENAI_KEY ? new OpenAI({ apiKey: OPENAI_KEY }) : null;

if (!openai) {
    console.error('⚠️ [WARNING] OpenAI Key not found (Checked API_KEY and APT_KEY). AI features disabled.');
}

const SimpleRAG = require('./rag');
const rag = new SimpleRAG(openai);
const gcs = require('./gcs'); 

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

// (Other routes kept minimal for stability)
app.get('/api/admin/stats', async (req, res) => {
    try {
        const clients = await Client.find({});
        res.json({ totalClients: clients.length, pendingApprovals: clients.filter(c => c.status === 'pending').length });
    } catch (err) { res.status(500).json({ error: err.message }); }
});

// START SERVER
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 [BACKEND READY] Listening on 0.0.0.0:${PORT}`);
    
    // Background Init
    setTimeout(() => {
        syncKnowledgeBase().catch(e => console.error('Background Error:', e));
    }, 2000);
});
