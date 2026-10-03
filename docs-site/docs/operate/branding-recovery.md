---
title: Recovering from a bad theme
---

# Recovering from a bad theme

A theme or custom CSS can make the panel hard to read or use. There are five ways back, from gentlest to last resort.

## 1. Let the preview end

[Try on this browser](/panel/appearance#try-before-you-keep-it) never changes anything for other people, and it goes back to
the saved look by itself after 60 seconds. If you only previewed it, just wait or press **Go back**.

## 2. Safe mode

Add `?safe=1` to any panel address, for example `https://panel.example.com/?safe=1`. For that browser tab, the panel ignores
the saved colours, fonts, shape and custom CSS and shows the built-in Fledge look. It works on the sign-in page too, and it is applied before anything else loads, so it works even if the appearance
data cannot be fetched. Safe mode is remembered for the tab; `?safe=0` leaves it. The name and logo you chose still show.

Use safe mode to sign in and fix the problem under **Settings → Appearance**.

## 3. Restore an earlier version

**Settings → Appearance → Advanced → Earlier versions** lists the last 20 saved versions with who saved them and what
changed. *Restore* makes an old version the newest. Images come back with it.

## 4. Reset to the Fledge look

**Advanced → Start over → Reset to the Fledge look** replaces the appearance with the defaults. The version you replaced stays
in the history.

## 5. Switch the appearance off on the server

If nobody can sign in at all, set this in `.env` and restart the API:

```sh
BRANDING_DISABLED=true
docker compose up -d api
```

While it is set, everyone sees the built-in look whatever is stored, and changes are refused (the editor says so). Nothing
is deleted. Remove the line and restart the API to use the saved appearance again.

As a last resort the saved appearance can be removed from the database; images and history stay in their tables:

```sh
docker compose exec postgres psql -U fledge -c "DELETE FROM settings WHERE key = 'branding'"
```

## Things that look like a bad theme but are not

| Symptom | Likely cause |
| --- | --- |
| The old name or colours show for a few seconds after saving | The panel's server caches the public document for a few seconds (and each API replica its settings for up to five); other open tabs refresh when you return to them |
| The logo is missing everywhere, the name is fine | The panel's server cannot reach the API at `API_INTERNAL_URL` (Compose sets `http://api:4000`). Images are fetched through the panel so that the content security policy can stay strict |
| The panel shows the Fledge look although you saved a theme | `BRANDING_DISABLED=true` is set, or the stored document failed its checks and the editor shows a warning at the top naming the section that was replaced by its default |
| Custom CSS has no effect | It is switched off, or it failed the checks: open the editor, the message under the CSS field says which rule |
| Emails still show the old name | Emails are written when they are sent. A queued or already delivered email keeps what it had |
| Light or dark does not follow the device | The person chose a mode in the account menu, which wins over *Match the device* |

More: [Troubleshooting](/operate/troubleshooting).
