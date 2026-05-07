const { Storage } = require('@google-cloud/storage');
const path = require('path');
const fs = require('fs');

// GCP Configuration from .env
const projectId = process.env.GCP_PROJECT_ID;
const bucketName = process.env.GCP_BUCKET_NAME;
const keyFilePath = process.env.GCP_KEY_FILE_PATH; // JSON key file path (e.g., 'gcp-key.json')

let storage;
let bucket;

const storageOptions = { projectId };
const fullKeyPath = keyFilePath ? path.join(__dirname, keyFilePath) : null;

if (fullKeyPath && fs.existsSync(fullKeyPath)) {
    storageOptions.keyFilename = fullKeyPath;
    console.log(`🔑 [GCS] Using key file: ${keyFilePath}`);
} else {
    console.log('🌐 [GCS] No key file found. Falling back to Application Default Credentials (ADC).');
}

try {
    storage = new Storage(storageOptions);
    bucket = storage.bucket(bucketName);
    // Note: GCS initialization is lazy, so we don't know for sure if it's active until the first call.
    // But we'll assume it's active if storage object is created.
    console.log(`☁️ [GCS] Storage initialized for bucket: ${bucketName}`);
} catch (err) {
    console.error('❌ [GCS] Initialization Error:', err.message);
}

/**
 * Uploads a file to the client's folder in the bucket
 * @param {string} clientId 
 * @param {string} fileName 
 * @param {Buffer|string} fileContent - Buffer or path to local file
 */
async function uploadToBucket(clientId, fileName, fileContent) {
    if (!bucket) {
        console.log('🚫 [GCS] Bucket not active. Skipping upload.');
        return null;
    }
    
    const destFileName = `${clientId}/${fileName}`;
    const file = bucket.file(destFileName);

    try {
        // If fileContent is a string, assume it's a file path
        if (typeof fileContent === 'string' && fs.existsSync(fileContent)) {
            await bucket.upload(fileContent, {
                destination: destFileName,
            });
        } else {
            // Assume it's a Buffer or direct content
            await file.save(fileContent);
        }
        
        // Make the file public so Interakt/WhatsApp can access it
        try {
            await file.makePublic();
        } catch (pubErr) {
            console.warn(`⚠️ [GCS] Could not make ${fileName} public. Ensure bucket permissions allow it.`);
        }
        
        console.log(`✅ [GCS] File uploaded to: ${destFileName}`);
        return `https://storage.googleapis.com/${bucketName}/${destFileName}`;
    } catch (err) {
        console.error(`❌ [GCS] Upload Error for ${fileName}:`, err.message);
        throw err;
    }
}

/**
 * Deletes a file from the bucket
 */
async function deleteFromBucket(clientId, fileName) {
    if (!bucket) return;
    try {
        const destFileName = `${clientId}/${fileName}`;
        await bucket.file(destFileName).delete();
        console.log(`🗑️ [GCS] File deleted: ${destFileName}`);
    } catch (err) {
        console.error(`❌ [GCS] Delete Error:`, err.message);
    }
}

/**
 * Lists all files in a client's folder
 */
async function listClientFiles(clientId) {
    if (!bucket) return [];
    try {
        const [files] = await bucket.getFiles({ prefix: `${clientId}/` });
        return files.map(file => file.name.split('/').pop()).filter(name => name && name !== '.keep');
    } catch (err) {
        console.error(`❌ [GCS] List Error for ${clientId}:`, err.message);
        return [];
    }
}

/**
 * Downloads a file from the bucket to a local path
 */
async function downloadFromBucket(clientId, fileName, localPath) {
    if (!bucket) return;
    try {
        const remoteFilePath = `${clientId}/${fileName}`;
        const dir = path.dirname(localPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        
        await bucket.file(remoteFilePath).download({ destination: localPath });
        console.log(`📥 [GCS] Downloaded: ${remoteFilePath} -> ${localPath}`);
    } catch (err) {
        console.error(`❌ [GCS] Download Error for ${fileName}:`, err.message);
    }
}

module.exports = {
    storage,
    bucket,
    uploadToBucket,
    deleteFromBucket,
    listClientFiles,
    downloadFromBucket,
    isGcsActive: !!bucket
};
