# MUIZI CDN
*a muizi project.*

## Warning(s):
This project is meant to be tunneled through cloudflare. 

The `BASE_URL` is required, please set it as your URL for the CDN to work properly.

It is recommended to run administrator in the terminal you are starting the CDN in.

## Introduction:
What is a CDN? A CDN stands for **Content Delivery Network**.

A CDN provides a way to upload and share images, videos or whatever you want.

This project provides you with a fully functional CDN.

The steps to get **your** CDN up and running is below.

## Step 1:
Install dependencies.
```bash
cd ..\muizi-cdn
npm init -y
npm install express busboy helmet cors compression dotenv crypto ffmpeg-static better-sqlite3
```

## Step 2:
Configure your .env.
```bash
PORT=3000
BASE_URL=https://cdn.example.com
OWNER_API_KEY=randomgenkey
```
Details:
- `PORT=3000` should be left as **3000** unless the port is being used by another process.
- `BASE_URL=https://cdn.example.com` should be set as your URL. (exm: https://cdn.yourdomain.com)
- `OWNER_API_KEY=randomgenkey` should be set to a random generated set of characters. This is the key you will give the CDN when uploading.

## Step 3:
Start the CDN.
```bash
npm start
```

## Step 4:
Modify `example-upload.html`
In any text editor, open up the file. Open the find tool and paste in:
```bash
https://cdn.example.com
```
Replace that URL in the file with the url you put in `BASE_URL`.

## Step 5:
To start serving `example-upload.html`, use,
```bash
npx serve
```
Once npx is served, open the localhost and find the `example-upload.html` file. 

Click on it to open it, Put in your api key, choose a file to upload, then click upload. 

This will confirm if **your** CDN is working correctly.

## Notes:
- The CDN should automatically create the required folders, if the CDN fails to create them, run these commands:
```bash
cd ..\muizi-cdn
mkdir uploads temp
```
- This project uses `better-sqlite3` to store metadata. You will need an app to view the `cdn.db` (metadata) file.
- This project was built on a windows pc, and has only been tested on a windows pc.
- This project is recommended for personal projects, it has not been tested for production projects (bigger projects).
- This project is still in beta, **may not** be fully optimized.
- This project allows images, videos and gifs to be displayed in discord.
