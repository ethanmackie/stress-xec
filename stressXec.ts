import {
    shaRmd160,
    TxBuilder,
    Script,
    P2PKHSignatory,
    fromHex,
    toHex,
    HdNode,
    ALL_BIP143,
} from 'ecash-lib';
import type { TxBuilderInput, TxBuilderOutput } from 'ecash-lib';
import bip39 from 'bip39';
import ecashaddr from 'ecashaddrjs';
import fs from 'fs';
import { ChronikClient } from 'chronik-client';

const chronik = new ChronikClient(['https://chronik-testnet2.fabien.cash']);

// Stress Test Configuration
const FUNDING_MNEMONIC = 'INSERT MNEMONIC'; // wallet that will fund all the minion wallets
const NUM_WALLETS = 10; // number of minion wallets to generate
const SATS_TO_FUND = 2000n; // fund each NUM_WALLETS with sats (20 XEC)
const SATS_TO_SEND = 1000n; // sats to be sent from each generated wallet to itself (10 XEC)

type Wallet = {
    hash: string;
    address: string;
    sk: Uint8Array;
    pk: Uint8Array;
};

// Retrieve utxos for the sending wallet
async function fetchUtxos(hash: string) {
    try {
        const utxos = await chronik.script('p2pkh', hash).utxos();
        return utxos.utxos;
    } catch (error: any) {
        console.error('Error fetching UTXOs:', error.message);
        return [];
    }
}

// Build a transaction, used for both the initial funding tx and the subsequent minion sends
async function buildTx(
    sk: Uint8Array,
    pk: Uint8Array,
    satoshisToSend: bigint,
    senderHash: string,
    wallets: Wallet[],
): Promise<string | null> {
    const utxos = await fetchUtxos(senderHash);
    if (utxos.length === 0) {
        console.log('No UTXOs available. Funding needed.');
        return null;
    }

    // Assumption: Only the initial one to many funding tx will have multiple recipient wallets in wallets array
    // Initial one to many tx will send SATS_TO_FUND
    let sendAmount = wallets.length > 1 ? SATS_TO_FUND : satoshisToSend;

    // Add outputs
    const outputs: TxBuilderOutput[] = [];
    for (const thisRecipient of wallets) {
        outputs.push({
            script: Script.fromAddress(thisRecipient.address),
            sats: sendAmount,
        });
    }
    // Add a change output (as leftover)
    outputs.push(Script.p2pkh(fromHex(senderHash)));

    // Select the appropriate input UTXOS
    const inputs: TxBuilderInput[] = [];
    let inputSatoshis = 0n;
    for (let i = 0; i < utxos.length + 1; i++) {
        const thisUtxo = i === utxos.length ? null : utxos[i];
        const needsAnotherUtxo = inputSatoshis <= sendAmount;
        if (needsAnotherUtxo) {
            if (thisUtxo === null) {
                console.log('Insufficient utxos');
                break;
            }
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

        try {
            const txBuilder = new TxBuilder({
                inputs,
                outputs,
            });
            const tx = txBuilder.sign({
                feePerKb: 2010n,
                dustSats: 546n,
            });
            const txSer = tx.ser();
            const hex = toHex(txSer);
            return hex;
        } catch (err: any) {
            if (
                typeof err.message !== 'undefined' &&
                err.message.startsWith('Insufficient input sats')
            ) {
                if (thisUtxo === null) {
                    break;
                }
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
            throw err;
        }
    }
    throw new Error('Insufficient funds');
}

// Populate the wallet object either by using an existing mnemonic or generate the wallet from scratch
async function createWallet(fundingMnemonic: string | false = false): Promise<Wallet> {
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
        hash: Buffer.from(hash).toString('hex'),
        address,
        sk: sk!,
        pk,
    };
}

// Subscribe to all txids
async function subscribeToAllTxids(
    txids: string[],
    txMap: Map<string, string>,
    eventLog: string[],
) {
    try {
        const ws = chronik.ws({
            onMessage: (msg: any) => {
                eventLog.push(`${msg.txid}, ${msg.msgType}`);
                if (msg.type === 'TX_FINALIZED') {
                    ws.unsubscribeFromTxid(msg.txid);
                    console.log(`Unsubscribed from ${msg.txid}`);
                }
                txMap.set(msg.txid, msg.msgType);
                console.clear();
                console.table(txMap);
            },
            onReconnect: (e: any) => {
                console.log(
                    'subscribeToAllTxids(): Reconnecting websocket, disconnection cause: ',
                    e,
                );
            },
        });
        await ws.waitForOpen();
        for (const thisTxid of txids) {
            ws.subscribeToTxid(thisTxid);
        }
    } catch (err: any) {
        console.log(
            'subscribeToAllTxids: Error in chronik websocket subscription: ' +
                err,
        );
    }
}

// Main stress test function
async function runStressTest() {
    const eventLog: string[] = [];
    const fundingWallet = await createWallet(FUNDING_MNEMONIC);
    const wallets: Wallet[] = [];
    for (let i = 0; i < NUM_WALLETS; i++) {
        const wallet = await createWallet();
        wallets.push(wallet);
    }
    const fundingSatsAmount = BigInt(NUM_WALLETS) * SATS_TO_FUND;
    const fundingTx =  await buildTx(
        fundingWallet.sk,
        fundingWallet.pk,
        fundingSatsAmount,
        fundingWallet.hash,
        wallets,
    );
    if (!fundingTx) {
        throw new Error('Failed to build funding transaction');
    }
    const fundingTxResponse = await chronik.broadcastTx(fundingTx);
    console.log(`Initial funding broadcast Response: `, fundingTxResponse)
    const stressTxs: string[] = [];
    for (const thisWallet of wallets) {
        console.log(`Building rawTx sending ${SATS_TO_SEND} sats to ${thisWallet.address}`)
        const thisTx = await buildTx(
            thisWallet.sk,
            thisWallet.pk,
            SATS_TO_SEND,
            thisWallet.hash,
            [thisWallet],
        );
        if (thisTx) {
            stressTxs.push(thisTx);
        }
    }
    const stressTxResponse = await chronik.broadcastTxs(stressTxs);
    const txMap = new Map<string, string>();
    for (const thisTxid of stressTxResponse.txids) {
        txMap.set(thisTxid, 'Unconfirmed');
        eventLog.push(`${thisTxid}, Unconfirmed`);
    }
    console.clear();
    console.table(txMap);
    await subscribeToAllTxids(stressTxResponse.txids, txMap, eventLog);
    process.on('SIGINT', () => {
        console.log('Exiting tool, exporting event log...');
        const csvEventLog = eventLog.join(',\n');
        const filePath = 'stresslog.csv';
        fs.writeFileSync(filePath, csvEventLog);
        console.log(`Exported to CSV file ${filePath}.`);
        process.exit();
    });
}

runStressTest().catch(console.error);