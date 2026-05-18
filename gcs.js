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
        // 1. Try strict path
        const strictPath = `${clientId}/${fileName}`;
        const [exists] = await bucket.file(strictPath).exists();

        if (exists) {
            await bucket.file(strictPath).delete();
            console.log(`🗑️ [GCS] File deleted (strict): ${strictPath}`);
            return;
        }

        // 2. Fallback: Search in legacy folders
        const [allFiles] = await bucket.getFiles();
        const targetFile = allFiles.find(f => {
            const parts = f.name.split('/');
            return parts.length >= 2 && parts[0].endsWith(`_${clientId}`) && parts[1] === fileName;
        });

        if (targetFile) {
            await targetFile.delete();
            console.log(`🗑️ [GCS] File deleted (legacy): ${targetFile.name}`);
        } else {
            console.warn(`⚠️ [GCS] Could not find file ${fileName} to delete for client ${clientId}`);
        }
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
        // 1. Try strict ID-only prefix
        let [files] = await bucket.getFiles({ prefix: `${clientId}/` });

        // 2. If nothing found, try legacy search (ANY folder that ends with _clientId)
        if (files.length === 0) {
            console.log(`[GCS] No files with strict ID prefix. Trying legacy suffix search for: *_${clientId}/`);
            const [allFiles] = await bucket.getFiles(); // This might be slow if bucket is huge, but necessary for migration
            files = allFiles.filter(file => {
                const parts = file.name.split('/');
                if (parts.length < 2) return false;
                const folderName = parts[0];
                return folderName === clientId || folderName.endsWith(`_${clientId}`);
            });
        }

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
        const dir = path.dirname(localPath);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

        // 1. Try default path (clientId/fileName)
        let remoteFilePath = `${clientId}/${fileName}`;
        let [exists] = await bucket.file(remoteFilePath).exists();

        // 2. Fallback: Search for legacy path (Name_ID/fileName)
        if (!exists) {
            console.log(`[GCS] File ${fileName} not found at ${remoteFilePath}. Searching for legacy folder...`);
            const [allFiles] = await bucket.getFiles();
            const legacyFile = allFiles.find(f => {
                const parts = f.name.split('/');
                return parts.length >= 2 && parts[0].endsWith(`_${clientId}`) && parts[1] === fileName;
            });

            if (legacyFile) {
                remoteFilePath = legacyFile.name;
                console.log(`[GCS] Found legacy file: ${remoteFilePath}`);
            } else {
                throw new Error(`File ${fileName} not found in any folder for client ${clientId}`);
            }
        }

        await bucket.file(remoteFilePath).download({ destination: localPath });
        console.log(`📥 [GCS] Downloaded: ${remoteFilePath} -> ${localPath}`);
    } catch (err) {
        console.error(`❌ [GCS] Download Error for ${fileName}:`, err.message);
    }
}

/**
 * Gets the public URL for a file, checking both strict and legacy paths
 */
async function getPublicUrl(clientId, fileName) {
    if (!bucket) return null;
    try {
        // 1. Try strict path
        const strictPath = `${clientId}/${fileName}`;
        const [exists] = await bucket.file(strictPath).exists();
        if (exists) {
            return `https://storage.googleapis.com/${bucketName}/${strictPath}`;
        }

        // 2. Fallback: Search in legacy folders
        const [allFiles] = await bucket.getFiles();
        const targetFile = allFiles.find(f => {
            const parts = f.name.split('/');
            return parts.length >= 2 && parts[0].endsWith(`_${clientId}`) && parts[1] === fileName;
        });

        if (targetFile) {
            return `https://storage.googleapis.com/${bucketName}/${targetFile.name}`;
        }

        return null;
    } catch (err) {
        console.error(`❌ [GCS] getPublicUrl Error:`, err.message);
        return null;
    }
}

module.exports = {
    storage,
    bucket,
    bucketName,
    uploadToBucket,
    deleteFromBucket,
    listClientFiles,
    downloadFromBucket,
    getPublicUrl,
    isGcsActive: !!bucket
};
