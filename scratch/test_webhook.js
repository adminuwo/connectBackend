const axios = require('axios');

async function testHandover() {
    console.log('🧪 Starting Handover Test...');
    const clientId = '1778218801097'; // Abha Jatav
    const webhookUrl = `http://localhost:8080/webhook/interakt/${clientId}`;

    const payload = {
        type: 'message_sent', // Sent by workflow
        data: {
            message: {
                customer_number: '+918359890909',
                text: 'talk to bot',
                is_sent_by_me: true,
                type: 'Text',
                id: 'test_msg_' + Date.now()
            }
        }
    };

    try {
        console.log('📡 Sending "talk to bot" mock webhook...');
        const response = await axios.post(webhookUrl, payload);
        console.log('✅ Webhook Response:', response.data);
        console.log('ℹ️ Check the terminal where "npm run dev" is running to see AI processing logs.');
    } catch (err) {
        console.error('❌ Test Failed:', err.response?.data || err.message);
    }
}

testHandover();
