# Moss Ball Event Cover Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Generate and publish a cover image for the 「植生布植生牆｜布苔球」 event without changing registration data.

**Architecture:** Keep the generated source image in the website's public asset tree so it has a stable HTTPS URL. Import that URL through the website MCP image pipeline, then update only the event `image_key` after a dry-run diff.

**Tech Stack:** Built-in ImageGen, static public asset, Vercel deployment, Interval Books content MCP.

---

### Task 1: Persist the generated cover

**Files:**
- Create: `public/generated/event-20261220-moss-ball-cover.png`

1. Copy the approved generated image into the public asset directory.
2. Confirm it is a valid square PNG.
3. Commit and push the asset branch to `main` so the stable production URL is available.

### Task 2: Import the image into the website library

1. Verify `https://www.intervalbooks.tw/generated/event-20261220-moss-ball-cover.png` returns HTTP 200.
2. Call `upload_image_from_url` with that URL.
3. Record the returned image key.

### Task 3: Attach the cover to the event

1. Call `update_event` for event `5a8a3111-fecc-4eb6-80dc-606e79035844` with only the new `image_key` and `dry_run=true`.
2. Verify the preview changes only `image_key`.
3. Call the same update with `dry_run=false`.
4. Read the event back and verify the new key while title, price, session and plan data remain unchanged.
5. Open the public activity page and confirm the cover is visible.
