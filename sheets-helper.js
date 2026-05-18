const { google } = require('googleapis');
const path = require('path');
const fs = require('fs');

let auth;
const keyPath = process.env.GCP_KEY_FILE_PATH ? path.join(__dirname, process.env.GCP_KEY_FILE_PATH) : null;

try {
    if (keyPath && fs.existsSync(keyPath)) {
        auth = new google.auth.GoogleAuth({
            keyFile: keyPath,
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        console.log('✅ [SHEETS AUTH] Service Account Key file loaded.');
    } else {
        auth = new google.auth.GoogleAuth({
            scopes: ['https://www.googleapis.com/auth/spreadsheets'],
        });
        console.log('🌐 [SHEETS AUTH] Application Default Credentials (ADC) loaded.');
    }
} catch (authErr) {
    console.error('❌ [SHEETS AUTH ERROR] Google Auth failed:', authErr.message);
}

function extractSpreadsheetId(url) {
    if (!url) return null;
    const matches = url.match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
    return matches ? matches[1] : url; // If not a URL, assume it's already an ID
}

/**
 * Validates a sheet and returns its tab names & column headers of the first tab
 */
async function validateAndFetchStructure(spreadsheetUrlOrId) {
    const spreadsheetId = extractSpreadsheetId(spreadsheetUrlOrId);
    if (!spreadsheetId) throw new Error('Invalid Google Sheet URL or Spreadsheet ID.');

    const sheets = google.sheets({ version: 'v4', auth });

    try {
        // Fetch spreadsheet metadata (tabs/sheets info)
        const doc = await sheets.spreadsheets.get({ spreadsheetId });
        const tabs = doc.data.sheets.map(s => s.properties.title);
        
        if (tabs.length === 0) throw new Error('No tabs found in the spreadsheet.');

        // Fetch headers from the first tab
        const defaultTab = tabs[0];
        const range = `${defaultTab}!A1:Z1`;
        const valuesResponse = await sheets.spreadsheets.values.get({
            spreadsheetId,
            range
        });

        const headers = valuesResponse.data.values ? valuesResponse.data.values[0] : [];

        return {
            spreadsheetId,
            tabs,
            defaultTab,
            headers
        };
    } catch (err) {
        console.error('❌ [SHEET VALIDATION ERROR]', err.message);
        if (err.message.includes('The caller does not have permission')) {
            throw new Error('Permission Denied. Please ensure you have shared the Google Sheet with our Service Account email and set permission to "Editor".');
        }
        throw new Error(`Failed to load Google Sheet: ${err.message}`);
    }
}

/**
 * Syncs a single CRM row/lead to a Google Sheet based on connection configuration
 */
async function syncRow(connection, leadData) {
    const { spreadsheetId, tabName, mappings, rowBehavior, filters } = connection;
    const sheets = google.sheets({ version: 'v4', auth });

    // 1. Evaluate Filters
    if (filters && filters.length > 0) {
        const matchesAll = filters.every(f => {
            const val = (leadData[f.field] || "").toString().toLowerCase();
            const filterVal = (f.value || "").toString().toLowerCase();
            if (f.operator === 'equals') return val === filterVal;
            if (f.operator === 'contains') return val.includes(filterVal);
            return false;
        });
        if (!matchesAll) {
            console.log(`⏭️ [SYNC FILTER] Lead ${leadData.phone || leadData.customerPhone} did not pass sheet filters. Skipping.`);
            return false;
        }
    }

    try {
        // 2. Fetch existing headers from the sheet to align column indices
        const headerRange = `${tabName}!A1:Z1`;
        const headerRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: headerRange });
        let headers = headerRes.data.values ? headerRes.data.values[0] : [];

        if (headers.length === 0) {
            // If the sheet is empty, create headers from the mappings
            headers = Object.values(mappings);
            await sheets.spreadsheets.values.update({
                spreadsheetId,
                range: `${tabName}!A1`,
                valueInputOption: 'USER_ENTERED',
                requestBody: { values: [headers] }
            });
        }

        // 3. Map lead data to header columns
        const newRow = Array(headers.length).fill('');
        
        // Supported lead keys: name, phone, status, lastMessage, assignedAgent
        const crmData = {
            name: leadData.name || leadData.customerPhone || '',
            phone: leadData.phone || leadData.customerPhone || '',
            status: leadData.status || 'open',
            lastMessage: leadData.lastMessage || leadData.text || '',
            assignedAgent: leadData.assignedAgent || 'Unassigned'
        };

        // Fill columns matching mapped headers
        for (const [crmField, sheetColName] of Object.entries(mappings)) {
            const colIndex = headers.indexOf(sheetColName);
            if (colIndex !== -1) {
                newRow[colIndex] = crmData[crmField] || '';
            }
        }

        // 4. Handle Row Behaviors
        const keyField = 'phone'; // Phone is our primary key for uniqueness
        const keySheetColName = mappings[keyField];
        const keyColIndex = headers.indexOf(keySheetColName);

        if (rowBehavior === 'updateExisting' && keyColIndex !== -1) {
            // Read all rows
            const allRowsRes = await sheets.spreadsheets.values.get({ spreadsheetId, range: tabName });
            const allRows = allRowsRes.data.values || [];
            
            // Find if lead exists (skip header row at index 0)
            let existingRowIndex = -1;
            const targetKeyValue = crmData[keyField].toString().trim().replace('+', '');
            
            for (let i = 1; i < allRows.length; i++) {
                const rowVal = (allRows[i][keyColIndex] || "").toString().trim().replace('+', '');
                if (rowVal === targetKeyValue) {
                    existingRowIndex = i;
                    break;
                }
            }

            if (existingRowIndex !== -1) {
                // Update existing row
                const rowNumber = existingRowIndex + 1; // 1-based index
                await sheets.spreadsheets.values.update({
                    spreadsheetId,
                    range: `${tabName}!A${rowNumber}`,
                    valueInputOption: 'USER_ENTERED',
                    requestBody: { values: [newRow] }
                });
                console.log(`✅ [SHEETS SYNC] Updated Row ${rowNumber} for ${crmData[keyField]}`);
                return true;
            }
        }

        // Default or Fallback: Append Row
        await sheets.spreadsheets.values.append({
            spreadsheetId,
            range: `${tabName}!A1`,
            valueInputOption: 'USER_ENTERED',
            insertDataOption: 'INSERT_ROWS',
            requestBody: { values: [newRow] }
        });
        console.log(`✅ [SHEETS SYNC] Appended New Row for ${crmData[keyField]}`);
        return true;
    } catch (err) {
        console.error('❌ [SHEETS SYNC ERROR]', err.message);
        throw err;
    }
}

/**
 * Imports leads from a Google Sheet into CRM database (or chats history)
 */
async function importLeadsFromSheet(connection, saveLeadCallback) {
    const { spreadsheetId, tabName, mappings } = connection;
    const sheets = google.sheets({ version: 'v4', auth });

    try {
        const response = await sheets.spreadsheets.values.get({ spreadsheetId, range: tabName });
        const rows = response.data.values || [];

        if (rows.length <= 1) return 0; // Only headers or empty

        const headers = rows[0];
        let importedCount = 0;

        for (let i = 1; i < rows.length; i++) {
            const row = rows[i];
            const leadData = {};

            // Map columns back to CRM fields
            for (const [crmField, sheetColName] of Object.entries(mappings)) {
                const colIndex = headers.indexOf(sheetColName);
                if (colIndex !== -1 && row[colIndex] !== undefined) {
                    leadData[crmField] = row[colIndex];
                }
            }

            if (leadData.phone) {
                await saveLeadCallback(leadData);
                importedCount++;
            }
        }

        return importedCount;
    } catch (err) {
        console.error('❌ [IMPORT LEADS ERROR]', err.message);
        throw err;
    }
}

/**
 * Exports all existing CRM leads/chats to a Google Sheet
 */
async function exportLeadsToSheet(connection, crmLeads) {
    const { spreadsheetId, tabName, mappings } = connection;
    const sheets = google.sheets({ version: 'v4', auth });

    try {
        // Prepare Headers
        const headers = Object.values(mappings);
        const values = [headers];

        // Format lead data
        for (const lead of crmLeads) {
            const row = Array(headers.length).fill('');
            const crmData = {
                name: lead.name || lead.customerPhone || '',
                phone: lead.phone || lead.customerPhone || '',
                status: lead.status || 'open',
                lastMessage: lead.lastMessage || lead.text || '',
                assignedAgent: lead.assignedAgent || 'Unassigned'
            };

            for (const [crmField, sheetColName] of Object.entries(mappings)) {
                const colIndex = headers.indexOf(sheetColName);
                if (colIndex !== -1) {
                    row[colIndex] = crmData[crmField] || '';
                }
            }
            values.push(row);
        }

        // Clear sheet and insert all
        await sheets.spreadsheets.values.clear({ spreadsheetId, range: tabName });
        await sheets.spreadsheets.values.update({
            spreadsheetId,
            range: `${tabName}!A1`,
            valueInputOption: 'USER_ENTERED',
            requestBody: { values }
        });

        return crmLeads.length;
    } catch (err) {
        console.error('❌ [EXPORT LEADS ERROR]', err.message);
        throw err;
    }
}

module.exports = {
    extractSpreadsheetId,
    validateAndFetchStructure,
    syncRow,
    importLeadsFromSheet,
    exportLeadsToSheet
};
