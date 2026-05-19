const axios = require('axios');

async function runTest() {
    const baseUrl = 'http://localhost:8080';
    console.log('🧪 Starting programmatic validation of Custom CRM Fields & Mapping...');

    try {
        // 1. Log in
        console.log('🔑 Authenticating...');
        const loginRes = await axios.post(`${baseUrl}/api/auth/login`, {
            email: 'abha@uwo24.com',
            password: 'Abha2004'
        });
        const token = loginRes.data.token;
        const clientId = loginRes.data.clientId;
        console.log(`✅ Logged in successfully. Client ID: ${clientId}`);

        const headers = { 'Authorization': `Bearer ${token}` };

        // 2. Fetch current custom fields
        console.log('GET custom fields...');
        let res = await axios.get(`${baseUrl}/api/client/${clientId}/custom-fields`, { headers });
        console.log('Current Custom Fields:', res.data);

        // 3. Update custom fields list (simulate Preset application)
        const mockFieldsList = ['Patient Name', 'Appointment Date', 'Symptoms', 'Doctor Name'];
        console.log(`POST custom fields (Preset: Hospital) -> ${JSON.stringify(mockFieldsList)}`);
        res = await axios.post(`${baseUrl}/api/client/${clientId}/custom-fields`, {
            customFields: mockFieldsList
        }, { headers });
        console.log('Updated Custom Fields list:', res.data);

        // 4. Update a lead's custom fields values
        // Let's get contacts first to find a valid phone number
        console.log('GET contacts...');
        const contactsRes = await axios.get(`${baseUrl}/api/client/${clientId}/contacts`, { headers });
        const contacts = contactsRes.data;
        console.log(`Found ${contacts.length} contacts.`);
        
        if (contacts.length > 0) {
            const testContact = contacts[0];
            const testPhone = encodeURIComponent(testContact.phone);
            console.log(`Updating lead custom fields for: ${testContact.name} (${testContact.phone}) -> ${testPhone}...`);
            
            const customFieldsData = {
                'Patient Name': 'John Doe',
                'Appointment Date': '2026-06-01',
                'Symptoms': 'Fever & Cough',
                'Doctor Name': 'Dr. House'
            };

            const updateRes = await axios.post(`${baseUrl}/api/client/${clientId}/chats/${testPhone}/update`, {
                customFields: customFieldsData,
                notes: 'Test note with custom fields'
            }, { headers });

            console.log('Update response:', updateRes.data);

            // Fetch contacts again and check fields
            console.log('Verifying lead details updated...');
            const verifyRes = await axios.get(`${baseUrl}/api/client/${clientId}/contacts`, { headers });
            const updatedContact = verifyRes.data.find(c => c.phone.trim() === testContact.phone.trim());
            console.log('Updated Lead customFields value in database:', updatedContact ? updatedContact.customFields : 'Not Found');
            console.log('Updated Lead notes in database:', updatedContact ? updatedContact.notes : 'Not Found');
            
            if (updatedContact.customFields && updatedContact.customFields['Patient Name'] === 'John Doe') {
                console.log('🎉 SUCCESS: Custom CRM Fields and mappings successfully validated!');
            } else {
                console.error('❌ FAILED: Custom fields not set correctly.');
            }
        } else {
            console.log('⚠️ No contacts to update.');
        }

    } catch (err) {
        console.error('❌ Test failed with error:', err.response ? err.response.data : err.message);
    }
}

runTest();
