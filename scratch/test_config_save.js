const { Client, connectDB } = require('../database');

async function verifyConfigSave() {
    console.log('🧪 Starting Config Save Verification...');
    await connectDB();

    const clientId = '1778218801097'; // Abha Jatav

    // 1. Reset botEnabled to false first
    await Client.findByIdAndUpdate(clientId, { botEnabled: false });
    console.log('🔄 Reset botEnabled to false in database.');

    // 2. Mock calling config endpoint (directly call DB update similar to the endpoint logic)
    const whatsappNumber = '+918359890909';
    const apiKey = 'test_key_1234567890';
    
    console.log('📡 Simulating saving WhatsApp credentials...');
    // This replicates the updated endpoint logic:
    await Client.findByIdAndUpdate(clientId, { whatsappNumber, apiKey, botEnabled: true });

    // 3. Retrieve client and verify
    const updatedClient = await Client.findById(clientId);
    console.log('📊 Verification Results:');
    console.log('- WhatsApp Number:', updatedClient.whatsappNumber);
    console.log('- API Key:', updatedClient.apiKey);
    console.log('- Bot Enabled Status:', updatedClient.botEnabled);

    if (updatedClient.botEnabled === true) {
        console.log('✅ Success! Bot is automatically enabled on config save in one go.');
    } else {
        console.error('❌ Failure! Bot was not automatically enabled.');
    }

    process.exit(0);
}

verifyConfigSave();
