require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8']);
const { Client, isLocal } = require('../database');
const gcs = require('../gcs');

async function setup() {
    console.log(`🚀 Starting Admin Setup (${isLocal ? 'LOCAL' : 'LIVE'} mode)...`);

    try {
        const adminEmail = 'admin@uwo24.com';
        const adminPassword = 'Admin@24';

        console.log(`👤 Setting up admin: ${adminEmail}`);
        
        let admin = await Client.findOne({ email: adminEmail });
        
        if (admin) {
            console.log('📝 Admin exists. Updating password and role...');
            await Client.findByIdAndUpdate(admin._id || admin.id, { 
                password: adminPassword, 
                role: 'admin', 
                isAdmin: true,
                status: 'approved' 
            });
        } else {
            console.log('🆕 Creating new admin account...');
            const newAdmin = Client.new ? Client.new({
                name: 'Master Admin',
                email: adminEmail,
                password: adminPassword,
                role: 'admin',
                isAdmin: true,
                status: 'approved'
            }) : new Client({
                name: 'Master Admin',
                email: adminEmail,
                password: adminPassword,
                role: 'admin',
                isAdmin: true,
                status: 'approved'
            });
            await newAdmin.save();
        }
        console.log('✅ Admin account configured successfully.');

        console.log('\n☁️ Checking GCS Bucket connection...');
        console.log(`Bucket Name: ${process.env.GCP_BUCKET_NAME}`);
        
        if (gcs.isGcsActive) {
            try {
                const [files] = await gcs.storage.bucket(process.env.GCP_BUCKET_NAME).getFiles({ maxResults: 1 });
                console.log('✅ GCS Connection: SUCCESS');
                console.log(`📊 Bucket is accessible. Found ${files.length} test files.`);
            } catch (err) {
                console.error('❌ GCS Connection: FAILED');
                console.error(`Error details: ${err.message}`);
            }
        } else {
            console.warn('⚠️ GCS is NOT active in .env configuration.');
        }

        process.exit(0);
    } catch (err) {
        console.error('💥 Setup Failed:', err.message);
        process.exit(1);
    }
}

setup();
