import type { Page } from 'playwright-core';

export function transientCaptureError(error: unknown): error is Error {
  return (
    error instanceof Error &&
    (error.name === 'TimeoutError' || error.message.includes('Unable to capture screenshot'))
  );
}

/** A compositor surface can disappear during QR/verification navigation. */
export async function captureLoginImage(page: Page): Promise<Buffer> {
  try {
    return await page.screenshot({ type: 'jpeg', quality: 85, caret: 'initial', timeout: 2500 });
  } catch (error) {
    if (!transientCaptureError(error) || page.isClosed()) throw error;
    const cdp = await page.context().newCDPSession(page);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await page.bringToFront();
      const size = page.viewportSize();
      if (size) await page.setViewportSize(size);
      const capture = cdp.send('Page.captureScreenshot', {
        format: 'jpeg',
        quality: 85,
        fromSurface: true,
        ...(size ? { clip: { x: 0, y: 0, width: size.width, height: size.height, scale: 1 } } : {}),
        captureBeyondViewport: false,
      });
      const result = await Promise.race([
        capture,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(error), 2500);
        }),
      ]);
      return Buffer.from(result.data, 'base64');
    } catch {
      throw error;
    } finally {
      clearTimeout(timer);
      await cdp.detach().catch(() => {});
    }
  }
}
