const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

let useLocal = process.env.DB_MODE === 'json' || !process.env.MONGODB_URI;

if (!useLocal) {
    console.log('🔄 [DB] Attempting to connect to MongoDB...');
    mongoose.connect(process.env.MONGODB_URI, {
        serverSelectionTimeoutMS: 10000,
    })
    .then(() => {
        console.log('✅ [DB] Connected to MongoDB (Live Mode)');
    })
    .catch(err => {
        console.error('❌ [DB] MongoDB Connection Error:', err.message);
        console.log('⚠️ [DB] Connection failed. Please check your MongoDB Atlas IP Whitelist (add 0.0.0.0/0).');
        console.log('🏠 [DB] Falling back to Local Mode (JSON).');
        useLocal = true;
    });
} else {
    const reason = process.env.DB_MODE === 'json' ? 'DB_MODE=json' : 'MONGODB_URI is missing';
    console.log(`🏠 [DB] Running in Local Mode: Using JSON files for storage (${reason})`);
}

// Helper to handle JSON storage
const jsonDb = {
    read: (file) => {
        const filePath = path.join(__dirname, file);
        if (!fs.existsSync(filePath)) return [];
        try {
            const content = fs.readFileSync(filePath, 'utf8');
            return content ? JSON.parse(content) : [];
        } catch (err) {
            console.error(`Error reading ${file}:`, err.message);
            return [];
        }
    },
    write: (file, data) => {
        const filePath = path.join(__dirname, file);
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        } catch (err) {
            console.error(`Error writing ${file}:`, err.message);
        }
    }
};

// --- SCHEMAS (For MongoDB) ---
const ClientSchema = new mongoose.Schema({
    name: { type: String, required: true },
    email: { type: String, required: true, unique: true },
    password: { type: String, required: true },
    role: { type: String, default: 'client' },
    isAdmin: { type: Boolean, default: false },
    status: { type: String, default: 'pending' },
    whatsappNumber: { type: String, default: '' },
    apiKey: { type: String, default: '' },
    logoUrl: { type: String, default: '' },
    botEnabled: { type: Boolean, default: false },
    autoReplyRules: { type: String, default: '' },
    documents: [String],
    createdAt: { type: Date, default: Date.now }
});

const TicketSchema = new mongoose.Schema({
    clientId: String,
    clientName: String,
    status: { type: String, default: 'open' },
    messages: [{ sender: String, text: String, timestamp: { type: Date, default: Date.now } }],
    lastUpdate: { type: Date, default: Date.now }
});

const ChatSchema = new mongoose.Schema({
    clientId: String,
    customerPhone: String,
    messages: [{ sender: String, text: String, timestamp: { type: Date, default: Date.now } }],
    lastUpdate: { type: Date, default: Date.now }
});

const OTPSchema = new mongoose.Schema({
    email: { type: String, required: true },
    otp: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 600 }
});

const MongooseClient = mongoose.model('Client', ClientSchema);
const MongooseTicket = mongoose.model('Ticket', TicketSchema);
const MongooseChat = mongoose.model('Chat', ChatSchema);
const MongooseOTP = mongoose.model('OTP', OTPSchema);

// --- MOCK MODELS (For JSON) ---
class MockModel {
    constructor(fileName, ModelName) {
        this.fileName = fileName;
        this.ModelName = ModelName;
    }

    async find(query = {}) {
        let data = jsonDb.read(this.fileName);
        if (Object.keys(query).length > 0) {
            return data.filter(item => {
                return Object.entries(query).every(([key, value]) => item[key] === value);
            });
        }
        return data;
    }

    async findOne(query) {
        const results = await this.find(query);
        return results[0] || null;
    }

    async findById(id) {
        const data = jsonDb.read(this.fileName);
        return data.find(item => item._id === id || item.id === id) || null;
    }

    async findByIdAndUpdate(id, update) {
        let data = jsonDb.read(this.fileName);
        const index = data.findIndex(item => item._id === id || item.id === id);
        if (index !== -1) {
            data[index] = { ...data[index], ...update };
            jsonDb.write(this.fileName, data);
            return data[index];
        }
        return null;
    }

    async findOneAndUpdate(query, update, options = {}) {
        let data = jsonDb.read(this.fileName);
        const index = data.findIndex(item => {
            return Object.entries(query).every(([key, value]) => item[key] === value);
        });
        if (index !== -1) {
            data[index] = { ...data[index], ...update };
            jsonDb.write(this.fileName, data);
            return data[index];
        } else if (options.upsert) {
            const newItem = { _id: Date.now().toString(), ...query, ...update };
            data.push(newItem);
            jsonDb.write(this.fileName, data);
            return newItem;
        }
        return null;
    }

    async findByIdAndDelete(id) {
        let data = jsonDb.read(this.fileName);
        const filtered = data.filter(item => item._id !== id && item.id !== id);
        jsonDb.write(this.fileName, filtered);
        return { success: true };
    }

    async deleteOne(query) {
        let data = jsonDb.read(this.fileName);
        const index = data.findIndex(item => {
            return Object.entries(query).every(([key, value]) => item[key] === value);
        });
        if (index !== -1) {
            data.splice(index, 1);
            jsonDb.write(this.fileName, data);
        }
        return { success: true };
    }

    async deleteMany(query) {
        if (Object.keys(query).length === 0) {
            jsonDb.write(this.fileName, []);
            return { deletedCount: 100 }; // Dummy
        }
        let data = jsonDb.read(this.fileName);
        const filtered = data.filter(item => {
            return !Object.entries(query).every(([key, value]) => {
                if (typeof value === 'object' && value.$ne) return item[key] !== value.$ne;
                return item[key] === value;
            });
        });
        const deletedCount = data.length - filtered.length;
        jsonDb.write(this.fileName, filtered);
        return { deletedCount };
    }

    // Mock the "new Model().save()" pattern
    createInstance(data) {
        const fileName = this.fileName;
        const modelName = this.ModelName;
        
        // Define defaults based on model
        let defaults = { createdAt: new Date() };
        if (modelName === 'Client') {
            defaults = { ...defaults, status: 'pending', isAdmin: false, whatsappNumber: '', apiKey: '', logoUrl: '', botEnabled: false, autoReplyRules: '', documents: [] };
        } else if (modelName === 'Ticket' || modelName === 'Chat') {
            defaults = { ...defaults, messages: [], status: 'open', lastUpdate: Date.now() };
        }

        return {
            ...defaults,
            ...data,
            _id: data._id || Date.now().toString(),
            save: async function() {
                let dbData = jsonDb.read(fileName);
                const index = dbData.findIndex(item => item._id === this._id);
                if (index !== -1) {
                    dbData[index] = { ...this };
                } else {
                    dbData.push({ ...this });
                }
                delete dbData[dbData.length-1].save; // Clean up the save function
                jsonDb.write(fileName, dbData);
                return this;
            }
        };
    }
}

const JsonClient = new MockModel('clients.json', 'Client');
const JsonTicket = new MockModel('tickets.json', 'Ticket');
const JsonChat = new MockModel('chats.json', 'Chat');
const JsonOTP = new MockModel('otps.json', 'OTP');

// Helper to create a proxy that supports 'new' while keeping instance methods
const createProxy = (instance) => {
    return new Proxy(instance, {
        get: (target, prop) => {
            if (prop === 'new') return (data) => target.createInstance(data);
            const value = target[prop];
            return typeof value === 'function' ? value.bind(target) : value;
        }
    });
};

const Client = MongooseClient;
const Ticket = MongooseTicket;
const Chat = MongooseChat;
const OTP = MongooseOTP;

console.log('🔄 [DB] Attempting to connect to MongoDB Atlas...');
mongoose.connect(process.env.MONGODB_URI, {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS: 45000,
    family: 4
})
.then(() => console.log('✅ [DB] Connected to MongoDB (Live Mode)'))
.catch(err => {
    console.error('❌ [DB] MongoDB Connection Error:', err.message);
    console.log('⚠️ [DB] STRICT MODE: Connection failed. Check Atlas IP Whitelist (0.0.0.0/0).');
});

module.exports = { Client, Ticket, Chat, OTP, isLocal: () => false };
