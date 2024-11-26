const express = require('express');
const { exec } = require('child_process');
const bodyParser = require('body-parser');
const QRCode = require('qrcode');
const path = require('path');

const app = express();
app.use(bodyParser.json());
app.use(express.static('public'));

let watchList = [];
let detectedTransactions = [];
let startBlockHeight = null;

function runCommand(command, callback) {
    exec(command, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error executing command: ${error.message}`);
            return callback(error, null);
        }
        if (stderr) {
            console.error(`Command error: ${stderr}`);
            return callback(new Error(stderr), null);
        }
        callback(null, stdout.trim());
    });
}

function convertFeeRate(feeRateBtcPerKb) {
    const feeRateSatsPerVbyte = feeRateBtcPerKb * 100000000 / 1000;
    return Math.round(feeRateSatsPerVbyte);
}

function getCurrentBlockHeight() {
    return new Promise((resolve, reject) => {
        runCommand('bitcoin-cli -rpcwallet=spaceblocks getblockcount', (err, blockHeight) => {
            if (err) return reject(err);
            resolve(parseInt(blockHeight, 10));
        });
    });
}

app.get('/price', (req, res) => {
    const price = 0.001;
    res.json({ price });
});

app.get('/fee', (req, res) => {
    runCommand('bitcoin-cli -rpcwallet=spaceblocks estimatesmartfee 6', (err, result) => {
        if (err) return res.status(500).send(err.message);
        const feeRateBtcPerKb = JSON.parse(result).feerate;
        const feeRateSatsPerVbyte = convertFeeRate(feeRateBtcPerKb);
        res.json({ feeRate: feeRateSatsPerVbyte });
    });
});

app.get('/watchlist', (req, res) => {
    res.json({ watchList });
});

app.get('/transactions', (req, res) => {
    res.json({ detectedTransactions });
});

app.post('/generate-address', (req, res) => {
    runCommand('ord wallet --name spaceblocks receive', (err, result) => {
        if (err) return res.status(500).json({ error: err.message });
        
        try {
            const parsedResult = JSON.parse(result);
            const address = parsedResult.address;
            
            watchList.push({ address, status: 'pending' });
            
            res.json({ address });
        } catch (parseError) {
            res.status(500).json({ error: 'Error parsing address' });
        }
    });
});

app.get('/qr-code/:address', (req, res) => {
    const { address } = req.params;
    QRCode.toDataURL(address, (err, url) => {
        if (err) return res.status(500).json({ error: 'QR code generation failed' });
        res.json({ qrCode: url });
    });
});

function checkTransactions() {
    console.log('Starting transaction check...');
    runCommand('bitcoin-cli -rpcwallet=spaceblocks listunspent', (err, utxos) => {
        if (err) {
            console.error('Error listing unspent UTXOs:', err.message);
            return;
        }

        const unspent = JSON.parse(utxos);
        console.log(`Number of UTXOs to check: ${unspent.length}`);

        unspent.forEach(utxo => {
            if (!utxo.blockhash) return;

            runCommand(`bitcoin-cli -rpcwallet=spaceblocks getblock ${utxo.blockhash}`, (err, blockInfo) => {
                if (err) {
                    console.error(`Error fetching block info for blockhash ${utxo.blockhash}:`, err.message);
                    return;
                }

                const blockData = JSON.parse(blockInfo);
                const utxoBlockHeight = blockData.height;

                if (utxoBlockHeight >= startBlockHeight) {
                    console.log(`Processing UTXO for address ${utxo.address}, Block height: ${utxoBlockHeight}`);

                    watchList = watchList.map(watchEntry => {
                        const { address, status } = watchEntry;

                        if (utxo.address === address && status === 'pending') {
                            console.log(`Transaction detected for address ${address}, TXID: ${utxo.txid}`);

                            watchEntry.status = 'detected';

                            detectedTransactions.push({
                                address,
                                txid: utxo.txid,
                                amount: utxo.amount,
                                blockHeight: utxoBlockHeight
                            });

                            runCommand('bitcoin-cli -rpcwallet=spaceblocks estimatesmartfee 6', (err, result) => {
                                if (err) {
                                    console.error('Error fetching fee rate:', err.message);
                                    return;
                                }

                                const feeRateBtcPerKb = JSON.parse(result).feerate;
                                const feeRateSatsPerVbyte = convertFeeRate(feeRateBtcPerKb);

                                mintBitbar(address, feeRateSatsPerVbyte);
                            });
                        }

                        return watchEntry;
                    });
                }
            });
        });

        console.log('Transaction check completed.');
    });
}

function mintBitbar(address, feeRateSatsPerVbyte) {
    const svgPath = '1kB.svg';

    runCommand(`ord wallet --name spaceblocks inscribe --file ${svgPath} --destination ${address} --fee-rate ${feeRateSatsPerVbyte}`, (error, stdout, stderr) => {
        if (error) {
            console.error(`Error inscribing Ordinal: ${error.message}`);
            return;
        }
        console.log(`Bitbar successfully inscribed for address ${address} with fee-rate ${feeRateSatsPerVbyte}. Details: ${stdout}`);
    });
}

getCurrentBlockHeight()
    .then(blockHeight => {
        startBlockHeight = blockHeight;
        console.log(`Server started at block height: ${startBlockHeight}`);

        setInterval(checkTransactions, 30000);

        const PORT = process.env.PORT || 3000;
        app.listen(PORT, () => {
            console.log(`Server running on port ${PORT}`);
        });
    })
    .catch(err => {
        console.error('Error getting current block height:', err.message);
    });