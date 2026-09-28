import { defineConfig } from 'vite';

const SSL_PLUGIN = '@vitejs/plugin-basic-ssl';

export default defineConfig(async ({ mode }) => ({
  // `npm run dev:https`: the same dev server behind a self-signed certificate, for
  // testing on a phone over the local network. Motion sensors, geolocation and full
  // screen are only offered to secure pages, and http://192.168.x.x is not one - so
  // over plain `npm run dev` from a phone, POINT TO LOOK is simply not drawn. The
  // browser will warn about the certificate once; accept it and carry on.
  // Imported only in that mode, so plain `npm run dev` and the build never need the
  // plugin installed - a clone that has not re-run `npm install` still starts. The
  // name is in a variable so the config bundler does not try to resolve it up front.
  plugins: mode === 'https' ? [(await import(SSL_PLUGIN)).default()] : [],

  // Relative, so the same build works both at a domain root
  // (birds.protonumerique.net/) and under a subpath
  // (protonumerique.github.io/birds-within/). With base: '/' the built index.html
  // asks for /assets/... which 404s on a project page - a blank screen that works
  // perfectly in dev. `import.meta.env.BASE_URL` becomes './', so the catalogue
  // fetch resolves relative to the page too. Do not "fix" this back to '/'.
  base: './',

  server: {
    host: true,
    // Uncomment when step 2 moves to the multi-threaded WASM runtime: pthreads
    // needs SharedArrayBuffer, which needs cross-origin isolation. The production
    // host must send the same two headers - GitHub Pages cannot, Netlify and
    // Cloudflare Pages can.
    // headers: {
    //   'Cross-Origin-Opener-Policy': 'same-origin',
    //   'Cross-Origin-Embedder-Policy': 'require-corp',
    // },
  },

  // satellite.js v7 ships emscripten WASM builds, and the pthreads one contains
  // top-level await. Vite's default worker output format is 'iife', which cannot
  // express that, so a production build fails with UNSUPPORTED_FEATURE the moment
  // anything is imported from the package root. ES-format workers fix it, and are
  // what step 2's own propagation worker wants anyway.
  worker: {
    format: 'es',
  },

  build: {
    target: 'es2022',
    sourcemap: true,
  },
}));
