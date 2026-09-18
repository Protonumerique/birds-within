import { setObserver } from './config';

/**
 * Where the visitor is standing, if they ask to be asked.
 *
 * **Nothing here runs without a press.** A hero section that fires a permission dialog
 * at a passer-by is hostile, most people deny it, and a denial is sticky per origin -
 * so the one chance would be spent on someone who had not yet seen what the page is.
 * `locate` is called from inside a click and from nowhere else.
 *
 * There is no geocoder and there will not be one. A place name would mean a third-party
 * lookup per visitor, which is the arrangement `fetch-catalog.mjs` exists to avoid; the
 * sky does not need a name to be drawn, and the panel already says "your location".
 */

/** Whether this browser, in this frame, will even offer it. */
export function canLocate(): boolean {
  // Absent on http:, and absent in an iframe the embedding page has not given
  // `allow="geolocation"`. Either way the honest answer is not to offer it.
  return typeof navigator !== 'undefined' && 'geolocation' in navigator && isSecureContext;
}

/**
 * Ask the browser where we are and stand there. Resolves once the observer has moved;
 * rejects with something worth showing a person.
 *
 * It must be called synchronously from a user gesture, or Safari will not count it.
 */
export function locate(): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!canLocate()) {
      reject(new Error('this browser will not share a location here'));
      return;
    }

    /*
     * **A guard of our own, because the API's timeout does not cover the prompt.**
     *
     * `getCurrentPosition` starts counting once permission exists. While the dialog is
     * open - or if it is never shown, which is what a headless browser and some
     * embedded webviews do - neither callback fires and neither does the timeout. The
     * button then sits on LOCATING… for as long as the page is open, which reads as
     * broken rather than as waiting. So the UI gets its own deadline, and a callback
     * that arrives after it is ignored: a location that lands thirty seconds after
     * someone gave up and pressed LAUNCH would move the sky out from under them.
     */
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(
      () => finish(() => reject(new Error('no answer yet — still in Berlin'))),
      WAIT_MS
    );

    navigator.geolocation.getCurrentPosition(
      (pos) =>
        finish(() => {
          // `altitude` is height above the WGS-84 ellipsoid, which is exactly what the
          // propagator wants - but it is null on most devices, so 0 is the usual answer
          // and costs nothing: a hundred metres moves a pass by arcseconds.
          const alt = pos.coords.altitude;
          setObserver(pos.coords.latitude, pos.coords.longitude, alt == null ? 0 : alt / 1000);
          resolve();
        }),
      (err) => finish(() => reject(new Error(reason(err)))),
      // Coarse and cached: the sky is computed from where you are to the kilometre, not
      // to the metre, so there is no reason to wake a GPS for it.
      { enableHighAccuracy: false, timeout: WAIT_MS, maximumAge: 300000 }
    );
  });
}

/** How long the button is allowed to say LOCATING… before it gives the press back. */
const WAIT_MS = 15000;

function reason(err: GeolocationPositionError): string {
  switch (err.code) {
    case err.PERMISSION_DENIED:
      return 'location declined — still in Berlin';
    case err.POSITION_UNAVAILABLE:
      return 'no location available — still in Berlin';
    case err.TIMEOUT:
      return 'location timed out — still in Berlin';
    default:
      return 'location failed — still in Berlin';
  }
}
