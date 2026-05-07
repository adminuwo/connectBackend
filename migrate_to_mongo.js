const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
    console.error('❌ MONGODB_URI not found in .env');
    process.exit(1);
}

// Schemas
const ClientSchema = new mongoose.Schema({
    name: String,
    email: String,
    password: String,
    role: { type: String, default: 'client' },
    isAdmin: { type: Boolean, default: false },
    status: { type: String, default: 'pending' },
    whatsappNumber: String,
    apiKey: String,
    logoUrl: String,
    botEnabled: Boolean,
    autoReplyRules: String,
    documents: [String],
    createdAt: { type: Date, default: Date.now }
});

const TicketSchema = new mongoose.Schema({
    clientId: String,
    clientName: String,
    status: String,
    messages: Array,
    lastUpdate: Date
});

const ChatSchema = new mongoose.Schema({
    clientId: String,
    customerPhone: String,
    messages: Array,
    lastUpdate: Date
});

const Client = mongoose.model('Client', ClientSchema);
const Ticket = mongoose.model('Ticket', TicketSchema);
const Chat = mongoose.model('Chat', ChatSchema);

async function migrate() {
    try {
        console.log('🔄 Connecting to MongoDB Atlas...');
        await mongoose.connect(MONGODB_URI, {
            serverSelectionTimeoutMS: 15000,
            connectTimeoutMS: 15000
        });
        console.log('✅ Connected!');

        // 1. Migrate Clients
        const clientsPath = path.join(__dirname, 'clients.json');
        if (fs.existsSync(clientsPath)) {
            const clients = JSON.parse(fs.readFileSync(clientsPath, 'utf8'));
            console.log(`📂 Found ${clients.length} clients to migrate.`);
            for (let c of clients) {
                // Remove _id from JSON to let MongoDB generate its own if it's just a timestamp string
                // But if it's already a valid ObjectId-like string, we might want to keep it.
                // For this project, IDs are timestamps, so we'll store them as-is in _id (as string) 
                // OR we let MongoDB generate new ones. Let's keep them to maintain relations.
                const existing = await Client.findOne({ email: c.email });
                if (!existing) {
                    await Client.create(c);
                    console.log(`   ✅ Migrated client: ${c.name}`);
                } else {
                    console.log(`   ⏭️ Client ${c.email} already exists, skipping.`);
                }
            }
        }

        // 2. Migrate Tickets
        const ticketsPath = path.join(__dirname, 'tickets.json');
        if (fs.existsSync(ticketsPath)) {
            const tickets = JSON.parse(fs.readFileSync(ticketsPath, 'utf8'));
            console.log(`📂 Found ${tickets.length} tickets to migrate.`);
            for (let t of tickets) {
                await Ticket.create(t);
            }
            console.log('   ✅ Tickets migrated.');
        }

        // 3. Migrate Chats
        const chatsPath = path.join(__dirname, 'chats.json');
        if (fs.existsSync(chatsPath)) {
            const chats = JSON.parse(fs.readFileSync(chatsPath, 'utf8'));
            console.log(`📂 Found ${chats.length} chats to migrate.`);
            for (let ch of chats) {
                await Chat.create(ch);
            }
            console.log('   ✅ Chats migrated.');
        }

        console.log('\n✨ MIGRATION COMPLETE! All local data is now in MongoDB Atlas.');
    } catch (err) {
        console.error('❌ Migration failed:', err.message);
    } finally {
        await mongoose.disconnect();
    }
}

migrate();
