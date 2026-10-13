# Squeeze

Compress images in your browser. Nothing is uploaded.

Choose a target file size, a quality level, or a maximum dimension. Compare the original and compressed images before you download.

Built with [Agent Duel](https://github.com/bottomless/agent-duel).

## Use it

1. Drop up to 20 JPG, PNG, WebP, or AVIF images.
2. Choose **Target size**, **Quality**, or **Resize**.
3. Choose WebP, JPEG, or PNG.
4. Download one image or a ZIP.

The preview updates automatically. On a phone, tap **Adjust** to change the settings.

Target size lowers the quality first. It then reduces the dimensions until the file fits. There is no input or target size limit.

## Develop

Install Node.js 22, then run:

```sh
npm ci
npm run dev
```

Open http://127.0.0.1:5173.

## Check

```sh
npm run lint
npm run typecheck
npm test
npm run build
npm run test:e2e
```

The browser tests use Playwright. In CI, Chromium is installed before `npm run test:e2e`.

## Deploy

Push to `main`. The GitHub Actions workflow builds and tests the app, then deploys `dist` to GitHub Pages.

In the repository settings, select **GitHub Actions** as the Pages source. The build uses relative URLs, so it works in a project site.
