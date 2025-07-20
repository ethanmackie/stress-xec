const { ChronikClient } = require('chronik-client');
const {
    shaRmd160,
    TxBuilder,
    Script,
    P2PKHSignatory,
    fromHex,
    toHex,
    HdNode,
    ALL_BIP143,
} = require('ecash-lib');
const bip39 = require('bip39');
const ecashaddr = require('ecashaddrjs');
const fs = require('fs');
const chronik = new ChronikClient('https://chronik-testnet.fabien.cash');

// Stress Test Configuration
const FUNDING_MNEMONIC = 'INSERT MNEMONIC'; // wallet that will fund all the minion wallets
const NUM_WALLETS = 10; // number of minion wallets to generate
const SATS_TO_FUND = 2000n; // fund each NUM_WALLETS with sats (20 XEC)
const SATS_TO_SEND = 1000n; // sats to be sent from each generated wallet to itself (10 XEC)

// Retrieve utxos for the sending wallet
async function fetchUtxos(hash) {
    try {
        const utxos = await chronik.script('p2pkh', hash).utxos();
        return utxos.utxos;
    } catch (error) {
        console.error('Error fetching UTXOs:', error.message);
        return [];
    }
}

// Build a transaction, used for both the initial funding tx and the subsequent minion sends
async function buildTx(
    sk,
    pk,
    satoshisToSend,
    senderHash,
    wallets,
) {
    const utxos = await fetchUtxos(senderHash);
    if (utxos.length === 0) {
        console.log('No UTXOs available. Funding needed.');
        return null;
    }

    // Assumption: Only the initial one to many funding tx will have multiple recipient wallets in wallets array
    // Initial one to many tx will send SATS_TO_FUND
    let sendAmount = wallets.length > 1 ? SATS_TO_FUND : satoshisToSend;

    // Add outputs
    const outputs = [];
    for (const thisRecipient of wallets) {
        outputs.push({
            script: Script.fromAddress(thisRecipient.address),
            sats: sendAmount,
        })
    }

    // Add a change output
    // Note: ecash-lib expects this added as simply a script
    // Note: if a change output is not needed, ecash-lib will omit
    outputs.push(Script.p2pkh(fromHex(senderHash)));

    // Select the appropriate input UTXOS
    const inputs = [];
    let inputSatoshis = 0n;
    for (let i = 0; i < utxos.length + 1; i++) {
        const thisUtxo = i === utxos.length ? null : utxos[i];
        const needsAnotherUtxo = inputSatoshis <= sendAmount;
        if (needsAnotherUtxo) {
            // If we have already iterated through all utxos and there's still not enough
            if (thisUtxo === null) {
                console.log('Insufficient utxos');
                break;
            }

            // If inputSatoshis is less than or equal to sendAmount, we know we need
            // to add another input
            inputs.push({
                input: {
                    prevOut: thisUtxo.outpoint,
                    signData: {
                        sats: thisUtxo.sats,
                        outputScript: Script.p2pkh(fromHex(senderHash)),
                    },
                },
                signatory: P2PKHSignatory(sk, pk, ALL_BIP143),
            });
            inputSatoshis += thisUtxo.sats;

            // Do not bother trying to build and broadcast the tx unless
            // we have enough inputSatoshis to cover sendAmount + fee
            continue;
        }

        // If value of inputs exceeds value of outputs, we check to see if we also cover the fee

        const txBuilder = new TxBuilder({
            inputs,
            outputs,
        });

        let tx;
        try {
            tx = txBuilder.sign({
                feePerKb: 2010n,
                dustSats: 546,
            });
        } catch (err) {
            if (
                typeof err.message !== 'undefined' &&
                err.message.startsWith('Insufficient input sats')
            ) {
                // If we have already iterated through all utxos, we cannot add any more
                if (thisUtxo === null) {
                    break;
                }
                // add more to cover the tx fee
                inputs.push({
                    input: {
                        prevOut: thisUtxo.outpoint,
                        signData: {
                            sats: thisUtxo.sats,
                            outputScript: Script.p2pkh(fromHex(senderHash)),
                        },
                    },
                    signatory: P2PKHSignatory(sk, pk, ALL_BIP143),
                });
                inputSatoshis += thisUtxo.sats;
                continue;
            }

            // Throw any other error
            throw err;
        }

        // Otherwise, build the tx
        const txSer = tx.ser();
        const hex = toHex(txSer);
        return hex;
    }
    // If we go over all input utxos but do not have enough to send the tx, throw Insufficient funds error
    throw new Error('Insufficient funds');
}

// Populate the wallet object either by using an existing mnemonic or generate the wallet from scratch
async function createWallet(fundingMnemonic = false) {
    const mnemonic = fundingMnemonic ? fundingMnemonic : bip39.generateMnemonic(128);
    const rootSeedBuffer = await bip39.mnemonicToSeed(mnemonic, '');
    const masterHDNode = HdNode.fromSeed(rootSeedBuffer);
    const fullDerivationPath  = "m/44'/1899'/0'/0/0";
    const node = masterHDNode.derivePath(fullDerivationPath);
    const pk = node.pubkey();
    const address = ecashaddr.encodeCashAddress('ectest', 'p2pkh', shaRmd160(pk));
    const { hash } = ecashaddr.decodeCashAddress(address);
    const sk = node.seckey();

    return {
        hash: hash.toString(),
        address,
        sk: sk,
        pk,
    };
}

// Subscribe to all txids
async function subscribeToAllTxids(
    txids,
    txMap, // real time console table
    eventLog // full event logging
) {
    try {
        const ws = chronik.ws({
            onMessage: msg => {
                // Log this event for eventual export
                eventLog.push(`${msg.txid}, ${msg.msgType}`);

                // Stop monitoring tx once finalized
                if (msg.type === 'TX_FINALIZED') {
                    ws.unsubscribeFromTxid(msg.txid);
                    console.log(`Unsubscribed from ${msg.txid}`);
                }

                // Update the txid status upon new event
                txMap.set(msg.txid, msg.msgType);

                // Render refreshed status report to CLI
                console.clear();
                console.table(txMap);
            },
            onReconnect: e => {
                // Fired before a reconnect attempt is made:
                console.log(
                    'subscribeToAllTxids(): Reconnecting websocket, disconnection cause: ',
                    e,
                );
            },
        });

        // Wait for WS to be connected:
        await ws.waitForOpen();

        // Subscribe to all txids from batch broadcast
        for (const thisTxid of txids) {
            ws.subscribeToTxid(thisTxid);
        }
    } catch (err) {
        console.log(
            'subscribeToAllTxids: Error in chronik websocket subscription: ' +
                err,
        );
    }
}

// Main stress test function
async function runStressTest() {
    // Full event log for export purposes
    const eventLog = [];

    // Initialize sending wallet that funds minion wallets
    const fundingWallet = await createWallet(FUNDING_MNEMONIC);

    // Initialize minion wallets
    const wallets = [];
    for (let i = 0; i < NUM_WALLETS; i++) {
        const wallet = await createWallet();
        wallets.push(wallet);
    }

    // Build and send funding to each minion wallet via a one to many tx from funding wallet
    const fundingSatsAmount = BigInt(NUM_WALLETS) * SATS_TO_FUND;
    const fundingTx =  await buildTx(
        fundingWallet.sk,
        fundingWallet.pk,
        fundingSatsAmount,
        fundingWallet.hash,
        wallets,
    );
    const fundingTxResponse = await chronik.broadcastTx(fundingTx);
    console.log(`Initial funding broadcast Response: `, fundingTxResponse)

    // Build and send the batch raw transactions to be sent from the minion wallets
    const stressTxs = [];
    for (const thisWallet of wallets) {
        console.log(`Building rawTx sending ${SATS_TO_SEND} sats to ${thisWallet.address}`)
        const thisTx = await buildTx(
            thisWallet.sk,
            thisWallet.pk,
            SATS_TO_SEND,
            thisWallet.hash,
            [thisWallet],
        );
        stressTxs.push(thisTx);
    }
    const stressTxResponse = await chronik.broadcastTxs(stressTxs);

    // Map for real time console table displays
    const txMap = new Map();
    for (const thisTxid of stressTxResponse.txids) {
        txMap.set(thisTxid, 'Unconfirmed');
        // Log the initial unconfirmed state for each txid
        eventLog.push(`${thisTxid}, Unconfirmed`);
    }

    // Render initial status report to CLI
    console.clear();
    console.table(txMap);

    // Start listening to the newly generated transactions
    await subscribeToAllTxids(stressTxResponse.txids, txMap, eventLog);

    // When user ctrl+c, export eventLog to file
    process.on('SIGINT', () => {
        console.log('Exiting tool, exporting event log...');
        const csvEventLog = eventLog.join(',\n');

        // Export to file
        const filePath = 'stresslog.csv';
        fs.writeFileSync(filePath, csvEventLog, (err) => {
            if (err) {
                console.error('Error writing file:', err);
            } else {
                console.log(`Exported to CSV file ${filePath}.`);
            }
        });
        
        process.exit();
    });
}

// Run the stress test
runStressTest().catch(console.error);