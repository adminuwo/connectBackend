const mongoose = require('mongoose');
const fs = require('fs');
const path = require('path');

// Database mode will be determined during connectDB() call
let dbMode = 'json'; 

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
    botRules: { type: String, default: '' },
    botTriggerKeywords: { type: [String], default: [] },
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
    messages: [{ 
        sender: String, 
        text: String, 
        msgType: { type: String, default: 'text' }, 
        mediaUrl: { type: String, default: '' },
        timestamp: { type: Date, default: Date.now } 
    }],
    lastUpdate: { type: Date, default: Date.now },
    botPaused: { type: Boolean, default: false },
    handoverActive: { type: Boolean, default: false },
    handoverExpiresAt: Date
});

const CampaignSchema = new mongoose.Schema({
    clientId: String,
    name: { type: String, default: 'Untitled Campaign' },
    message: String,
    contacts: [String],
    mediaUrl: String,
    mediaType: String,
    fileName: String,
    scheduledAt: Date,
    timezone: { type: String, default: 'IST' },
    status: { type: String, default: 'scheduled' }, // scheduled, sending, sent, failed
    totalContacts: Number,
    sentCount: { type: Number, default: 0 },
    failedCount: { type: Number, default: 0 },
    automationId: String, // Link to an AutomationFlow
    createdAt: { type: Date, default: Date.now }
});

const AutomationFlowSchema = new mongoose.Schema({
    clientId: String,
    name: String,
    // Stages: [ { stageIndex, message, reminders: [] } ]
    stages: [{
        stageIndex: Number,
        message: {
            text: String,
            mediaUrl: String,
            mediaType: String
        },
        reminders: [{
            message: String,
            delayHours: Number,      // relative delay (hours)
            fixedTime: String,       // absolute datetime from dashboard calendar (ISO string)
            mediaUrl: String,
            mediaType: String
        }]
    }],
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

const AutomationStateSchema = new mongoose.Schema({
    clientId: String,
    customerPhone: String,
    automationId: String,
    currentStageIndex: { type: Number, default: 0 }, // Current active stage
    status: { type: String, default: 'pending' }, // pending (waiting for reply), reminder_sent, completed
    nextReminderIndex: { type: Number, default: 0 },
    nextReminderAt: Date,
    lastInteractionAt: { type: Date, default: Date.now },
    createdAt: { type: Date, default: Date.now }
});


const OTPSchema = new mongoose.Schema({
    email: { type: String, required: true },
    otp: { type: String, required: true },
    createdAt: { type: Date, default: Date.now, expires: 600 }
});

const MongooseClient = mongoose.model('Client', ClientSchema);
const MongooseTicket = mongoose.model('Ticket', TicketSchema);
const MongooseChat = mongoose.model('Chat', ChatSchema);
const MongooseCampaign = mongoose.model('Campaign', CampaignSchema);
const MongooseAutomation = mongoose.model('Automation', AutomationFlowSchema);
const MongooseAutoState = mongoose.model('AutomationState', AutomationStateSchema);
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
                return Object.entries(query).every(([key, value]) => {
                    if (value && typeof value === 'object' && value.$lte) {
                        return new Date(item[key]) <= new Date(value.$lte);
                    }
                    return item[key] === value;
                });
            });
        }
        return data;
    }

    async findOne(query) {
        const results = await this.find(query);
        const item = results[0] || null;
        return item ? this.createInstance(item) : null;
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
            return { deletedCount: 100 };
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

    createInstance(data) {
        const fileName = this.fileName;
        const modelName = this.ModelName;
        
        let defaults = { createdAt: new Date() };
        if (modelName === 'Client') {
            defaults = { ...defaults, status: 'pending', isAdmin: false, whatsappNumber: '', apiKey: '', logoUrl: '', botEnabled: false, autoReplyRules: '', documents: [] };
        } else if (modelName === 'Ticket' || modelName === 'Chat') {
            defaults = { ...defaults, messages: [], status: 'open', lastUpdate: Date.now(), botPaused: false };
        } else if (modelName === 'Campaign') {
            defaults = { ...defaults, status: 'scheduled', sentCount: 0, failedCount: 0, totalContacts: 0 };
        } else if (modelName === 'Automation') {
            defaults = { ...defaults, reminders: [], isActive: true };
        } else if (modelName === 'AutomationState') {
            defaults = { ...defaults, status: 'pending', nextReminderIndex: 0 };
        }

        return {
            ...defaults,
            ...data,
            _id: data._id || Date.now().toString(),
            save: async function() {
                let dbData = jsonDb.read(fileName);
                const index = dbData.findIndex(item => item._id === this._id);
                
                const savedItem = { ...this };
                delete savedItem.save;
                
                if (index !== -1) {
                    dbData[index] = savedItem;
                } else {
                    dbData.push(savedItem);
                }
                jsonDb.write(fileName, dbData);
                return this;
            }
        };
    }
}

const JsonClient = new MockModel('clients.json', 'Client');
const JsonTicket = new MockModel('tickets.json', 'Ticket');
const JsonChat = new MockModel('chats.json', 'Chat');
const JsonCampaign = new MockModel('campaigns.json', 'Campaign');
const JsonAutomation = new MockModel('automations.json', 'Automation');
const JsonAutoState = new MockModel('autostates.json', 'AutomationState');
const JsonOTP = new MockModel('otps.json', 'OTP');

const createConstructorProxy = (mockInstance) => {
    function MockConstructor(data) {
        return mockInstance.createInstance(data);
    }
    Object.getOwnPropertyNames(Object.getPrototypeOf(mockInstance)).forEach(prop => {
        if (prop !== 'constructor' && typeof mockInstance[prop] === 'function') {
            MockConstructor[prop] = mockInstance[prop].bind(mockInstance);
        }
    });
    MockConstructor.new = (data) => mockInstance.createInstance(data);
    return MockConstructor;
};

const isProduction = process.env.NODE_ENV === 'production' || !!process.env.K_SERVICE;

const connectDB = async () => {
    const forceAtlas = process.env.DB_MODE === 'atlas' || process.env.DB_MODE === 'mongodb';
    
    if (isProduction || forceAtlas) {
        if (!process.env.MONGODB_URI) {
            console.log('⚠️ [DB] MONGODB_URI is missing. Falling back to Local Mode.');
            dbMode = 'json';
            return;
        }

        try {
            await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000 });
            dbMode = 'atlas';
            const dbName = mongoose.connection.name;
            console.log(`✅ [DB] Connected to MongoDB Atlas (Database: ${dbName})`);
            
            // Log collections to verify we are in the right place
            const collections = await mongoose.connection.db.listCollections().toArray();
            console.log(`📂 [DB] Available collections: ${collections.map(c => c.name).join(', ')}`);
        } catch (err) {
            console.error('❌ [DB] MongoDB Connection Failed:', err.message);
            console.log('🏠 [DB] Falling back to Local Mode (JSON files)');
            dbMode = 'json';
        }
    } else {
        console.log('🏠 [DB] Running in Local Mode (JSON files)');
        dbMode = 'json';
    }
};

const ClientModel = createConstructorProxy(JsonClient);
const TicketModel = createConstructorProxy(JsonTicket);
const ChatModel = createConstructorProxy(JsonChat);
const CampaignModel = createConstructorProxy(JsonCampaign);
const AutomationModel = createConstructorProxy(JsonAutomation);
const AutoStateModel = createConstructorProxy(JsonAutoState);
const OTPModel = createConstructorProxy(JsonOTP);

module.exports = { 
    connectDB,
    get Client() { return dbMode === 'atlas' ? MongooseClient : ClientModel; },
    get Ticket() { return dbMode === 'atlas' ? MongooseTicket : TicketModel; },
    get Chat() { return dbMode === 'atlas' ? MongooseChat : ChatModel; },
    get Campaign() { return dbMode === 'atlas' ? MongooseCampaign : CampaignModel; },
    get Automation() { return dbMode === 'atlas' ? MongooseAutomation : AutomationModel; },
    get AutoState() { return dbMode === 'atlas' ? MongooseAutoState : AutoStateModel; },
    get OTP() { return dbMode === 'atlas' ? MongooseOTP : OTPModel; },
    isLocal: () => dbMode === 'json'
};
