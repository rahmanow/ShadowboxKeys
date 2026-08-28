// BEGIN Variables to change
// Prefer setting these via environment variables (OUTLINE_API_URL, OUTLINE_DOMAIN)
// so the Management API URL never ends up committed to version control.
const managementApiUrl = process.env.OUTLINE_API_URL || 'https://xx.xx.xx.xxx:16942/xxxxxxxxxxxxxxxxxxxxxx'; // Management API URL from Outline Manager > Settings
const domain = process.env.OUTLINE_DOMAIN || ''; // set your custom domain if you have one, e.g. 'vpn.example.com'
// END Variables to change


const fetch = require('node-fetch'); // if error run: npm install
const https = require('https');

// Outline's Management API uses a self-signed certificate, so verification
// must be disabled for this request. Only point this at servers you control.
const agent = new https.Agent({ rejectUnauthorized: false });

if (managementApiUrl.includes('xx.xx.xx.xxx')) {
    console.error('Please configure your Management API URL first.');
    console.error('Set the OUTLINE_API_URL environment variable, or edit the managementApiUrl constant in shadowboxKey.js.');
    process.exit(1);
}

const url = managementApiUrl.replace(/\/$/, '') + '/access-keys/';
const ip = new URL(managementApiUrl).hostname;
const host = domain || ip;

const getKeys = async () => {
    const response = await fetch(url, { agent });
    if (!response.ok) {
        throw new Error(`Management API responded with ${response.status} ${response.statusText}`);
    }
    const { accessKeys } = await response.json();
    for (const key of accessKeys) {
        const port = ':' + key.port;
        console.log(key.name + '\t' + key.accessUrl.replace(ip + port + '/?outline=1', host + port));
    }
};

getKeys()
    .then(() => console.log('Completed. These are all you have!'))
    .catch(err => {
        console.error('Failed to fetch access keys:', err.message);
        process.exit(1);
    });
