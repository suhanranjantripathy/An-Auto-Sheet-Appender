# Screenshot Sheet Updater

A local web app that analyzes a screenshot with Groq or xAI vision and appends the structured result to Google Sheets.

## Setup

1. Copy `.env.example` to `.env`.
2. Add your Groq API key (`gsk_...`) or an xAI API key.
3. Use the no-key Apps Script webhook method below, or use the service account fallback.

## No-key Google Sheets setup

Use this when the sheet owner does not want to share Google credentials.

Ask the client to do this inside their Google Sheet:

1. Open `Extensions > Apps Script`.
2. Paste the contents of `google-apps-script/Code.gs`.
3. Change `SHARED_TOKEN` to a private phrase and tell you that phrase.
4. Click `Deploy > New deployment`.
5. Choose `Web app`.
6. Set `Execute as` to `Me`.
7. Set `Who has access` to `Anyone with the link`.
8. Deploy and approve the permissions.
9. Send you the Web App URL.

Then put this in `.env`:

```text
GOOGLE_APPS_SCRIPT_WEBAPP_URL=https://script.google.com/macros/s/.../exec
GOOGLE_APPS_SCRIPT_TOKEN=the-token-the-client-chose
GOOGLE_SHEET_NAME=Sheet1
```

With this method, the client keeps Google access inside their own Sheet/account. Your app only posts rows to their webhook.

## Service account fallback

Use this only if the client is willing to share the Sheet with a service account.

1. Create a Google Cloud service account with Google Sheets API access.
2. Share your target Google Sheet with the service account email.
3. Put the service account email, private key, spreadsheet ID, and sheet tab name in `.env`.

The spreadsheet ID is the long value in a Google Sheets URL:

```text
https://docs.google.com/spreadsheets/d/SPREADSHEET_ID/edit
```

Recommended sheet headers:

```text
Customer Name, Mobile, Date, Vehicle Reg. No., Make-Model, Variant, Avg. km/mo, Odo Reading, Type of Service, Tyre Position, Brand, Platform, Size, NSD, Fitment Year
```

The app also has an **Append headers** button that writes these headers as a row.

## Run

```bash
npm start
```

Then open:

```text
http://localhost:3000
```

## Notes

- The app uses only built-in Node APIs, so no package install is required.
- Screenshots are sent to Groq or xAI for analysis.
- Google Sheets writes are performed through an Apps Script webhook or a service-account JWT.
- If your private key comes from Google as multiple lines, keep it quoted in `.env` and replace line breaks with `\n`.
