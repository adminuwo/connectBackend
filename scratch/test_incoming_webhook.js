const axios = require('axios');

async function testIncomingMessage() {
    console.log('🧪 Starting Incoming Message Test...');
    const clientId = '1778218801097'; // Abha Jatav
    const webhookUrl = `http://localhost:8080/webhook/interakt/${clientId}`;

    const payload = {
        type: 'message_received',
        data: {
            message: {
                customer_number: '+918359890909',
                text: 'What are your services?',
                is_sent_by_me: false,
                type: 'Text',
                id: 'incoming_msg_' + Date.now()
            }
        }
    };

    try {
        console.log('📡 Sending "What are your services?" mock incoming webhook...');
        const response = await axios.post(webhookUrl, payload);
        console.log('✅ Webhook Response:', response.data);
        console.log('ℹ️ Check the backend logs to see if OpenAI/RAG responded and sent a reply back to Interakt.');
    } catch (err) {
        console.error('❌ Test Failed:', err.response?.data || err.message);
    }
}

testIncomingMessage();
