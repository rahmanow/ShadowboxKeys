// BEGIN Variables to change
const managementApiUrl = 'https://xx.xx.xx.xxx:16942/k1CeXlhnXndHKlNTd3h-2w'; // Copy and paste Management API URL from Outline Manager Key Settings
const domain = 'testdomain.com'; // set your custom domain if you have one
// END Variables to change


const fetch = require('node-fetch'); // if error run: npm install node-fetch --save
const https = require("https");
const agent = new https.Agent({ rejectUnauthorized: false });

const url = managementApiUrl + '/access-keys/';
const ip = managementApiUrl.split('/')[2].split(':')[0];
const dom = () => { return domain ? domain : ip };

const getKeys = async () => {
    const response = await fetch( url, {agent} );
    const myJson = await response.json();
    const keys = myJson.accessKeys;
    for ( let i=0; i<keys.length; i++ ) {
        let key = keys[i];
        let port = ':' + key['port'];
        let name = key['name'];
        let accessUrl = key['accessUrl'];
        console.log(name + '' + accessUrl.replace(ip + port + '/?outline=1', dom()+ port));
    }
};
getKeys()
    .then(r => console.log("Completed. These are all you have!"))
    .catch(err => console.log(err));