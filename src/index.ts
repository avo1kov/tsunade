import 'dotenv/config';
import { createDriver, navigateToAlfa, waitForQrAndCapture, closeDriver, collectOperations } from './selenium.js';
import type { OperationItem } from './selenium.js';
import fs from 'node:fs/promises';
import { sendDocument, sendText } from './telegram.js';

async function main(): Promise<void> {
  await sendText('Starting Alfa Bank login flow. I will send QR shortly.');
  const driver = await createDriver(false);
  try {
    await navigateToAlfa(driver);
    // console.log('navigated to alfa');
    // const { screenshotPath, qrElementRect } = await waitForQrAndCapture(driver, 90_000);

    // let caption = 'Alfa Bank dashboard QR code screenshot.';
    // if (qrElementRect) {
    //   caption += `\nQR approx at x=${qrElementRect.x}, y=${qrElementRect.y}, w=${qrElementRect.width}, h=${qrElementRect.height}`;
    // } else {
    //   caption += '\nQR element not precisely detected; sending full screenshot.';
    // }

    // // await sendDocument(screenshotPath, caption);
    // const outPath = './dist/operations.json';
    // await fs.mkdir('./dist', { recursive: true });
    // const writeSnapshot = async (items: OperationItem[]) => {
    //   const json = JSON.stringify(items, null, 2);
    //   await fs.writeFile(outPath, json, 'utf-8');
    //   console.log('wrote snapshot items:', items.length);
    // };
    // const items = await collectOperations(driver, 50, writeSnapshot);
    // await writeSnapshot(items);
    await new Promise(resolve => setTimeout(resolve, 1000000));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await sendText(`Failed to capture/send QR: ${message}`);
    throw err;
  } finally {
    await closeDriver(driver);
  }
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err);
  process.exitCode = 1;
});


