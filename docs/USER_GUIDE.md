# LyricFlow — getting started

Your guest library holds up to three songs. When the site owner enables accounts, free registration creates a separate local profile with unlimited songs. Account profiles now back up songs, drafts and reader settings privately online. Community sharing is available after an explicit preview and confirmation; private synchronization never creates a public song. Already shared songs can automatically publish saved changes.

## Accounts and local profiles

Choose **Account** to register with an email address, a password of at least 12 characters (at most 72 bytes) and a unique public pseudonym. Pseudonyms use 3–30 lowercase letters, numbers, underscores or hyphens; **Anonymous** is reserved. Your email remains private. Verify your email using the link sent to your inbox when email delivery is enabled. **Forgot password?** sends a reset link; each link expires after an hour and can only be used once. A password reset signs out existing sessions.

**Continue with Google** appears when configured. New Google users choose their own pseudonym; the Google profile name is never published automatically. If your email already belongs to an account, sign in with its password first, then confirm that password before linking Google. Google sign-in never silently merges accounts with matching email addresses.

Check **Remember me** before **Sign in** or **Continue with Google** to stay signed in when you reopen the browser. It is off by default. Signing out, resetting your password or being banned revokes remembered access. Automatic sign-in does not count as a recent Google sign-in for account deletion: sign out and use Google again first. Your local songs remain on the device when you sign out.

The **Library on this device** selector identifies the active local profile. Guest songs stay in their original profile. **Copy guest songs to this profile** explicitly copies them into the signed-in profile and starts their private online backup; repeating the copy preserves existing edits and drafts. Signing in to another account opens a separate profile and never copies another profile's songs automatically. Profiles organize device data; they do not encrypt it or replace your device lock.

Signing out keeps the current profile's songs readable and editable. The guest creation limit applies again, even if the profile already contains more than three songs. Losing the network alone preserves unlimited access in a previously signed-in profile. No songs are deleted when a session expires or the account is banned.

To remove an old offline library, select it under **Library on this device**, choose **Delete local library**, and confirm. Sign out first if it belongs to the currently signed-in account. This works offline and permanently removes that library’s songs, drafts, settings, conflicts and unsynced changes from this device, including in other open tabs. Other local libraries and online data are kept. The selected account profile disappears from the selector; deleting Guest leaves an empty Guest library. Signing in again restores only data already backed up online.

## Private online backup and conflicts

**Synced** confirms that the server has acknowledged your changes. **Sync pending** means changes are still on this device. **Sign in to sync** asks you to reconnect the same account. Use **Sync now** to retry an unavailable connection. Keep this device’s site data until synchronization succeeds.

Songs, unfinished drafts and the light/dark preference become available in the same account on another device after synchronization. The editor saves drafts locally as you type; leaving the editor starts their online backup. Reading keeps working while synchronization runs. Offline edits remain queued until you return online.

If two devices change a song, **Choose a version** keeps both versions until you decide. Expand **Compare lyrics** to review the saved song, unfinished draft and timing settings. Choose **Keep device version**, **Keep online version** or **Keep both as separate songs**. No lyrics are merged automatically. Keeping a song that was deleted online creates a new song, so an old device cannot silently undo a deletion.

Deleting a song in an account profile also deletes it on other devices after synchronization. **Account → Delete account** permanently removes private server data. Type your pseudonym and confirm your current password; Google-only accounts need a recent sign-in. Choose whether to keep your local songs and drafts. Kept songs use the guest creation limit. Other devices keep their downloaded copies but cannot sync with the deleted account.

## Add and edit a song

Choose **New song**, enter a title, artist and lyrics. Each written line is one musical step. Long lines may wrap on screen, but they always advance together. Drafts save automatically; **Save song** adds the song to your library. Unfinished drafts can be resumed after reopening the app. Use **Try a sample** for an original demonstration song.

**Music links** accepts one optional HTTPS link for each of YouTube, YouTube Music, Deezer and Spotify. Paste a video or track link from the matching service. YouTube short video links and the Deezer/Spotify share short links are supported. Clear a field to remove its link. Invalid links can remain in an autosaved draft, but must be corrected before **Save song** or **Open prompter**. The app checks URL structure and service, without checking whether the music exists or is available in your region.

The music links at the top of the prompter open in a new tab. Audio does not play inside LyricFlow. Music links are backed up with your song and included in the public preview, shared revisions and private copies; unfinished drafts stay private. Opening a music service requires a connection.

The defaults are **120 BPM**, **4 beats per bar** and **1 bar per line**. Change these in **Timing**. Use a decimal point for fractional measures, for example `1.5`.

To measure a song's tempo, repeatedly press the metronome **Tap tempo** button in **Timing**, once per beat. After two taps, the estimate appears in BPM and averages up to the last eight intervals. Choose **Use this BPM** to copy it to **Song BPM** and the draft, then save as usual. A gap of five seconds before the next tap or putting the app in the background starts a fresh measurement. Measuring does not change the song until you apply the result. This tool also works offline.

Add an optional Verse, Chorus or Solo label with **Section**. Headings and blank lines take no time.

## Control the timing

```text
[line tempo=80 bars=2] Two bars at 80 BPM
[line tempo=80%] Follow 80% of the song BPM

[tempo=90]
A passage at 90 BPM
Another line
[/tempo]

[line beats=6] Six beats regardless of beats per bar

[line tempo=80% beats=4]
Each line lasts four beats
At 80% of the song BPM
[line bars=2] Two bars instead of four beats
[/line]

[pause bars=4]
[pause beats=8]
[pause seconds=5]
```

A line setting takes priority over its passage. Fixed tempos stay fixed when you change the song BPM. Percentages follow that BPM.

The passage duration applies to each lyric line. Choose either bars or beats: six beats at 120 BPM last three seconds, whether a bar has three or four beats. A line duration replaces the passage duration completely, even across units; a tempo-only line keeps the passage duration. Pauses keep their own duration and inherit only the passage tempo. Timing passages cannot be nested, including inside legacy tempo passages. Close each passage with its matching tag.

Use the editor buttons to insert indications, or type them directly. Select whole lyric lines before choosing **Timing passage** to wrap them. Choose an optional tempo, an optional duration and Bars or Beats. A tempo-only passage uses the legacy `[tempo=…]` syntax. **Line timing** offers the same units for one line; replacing its duration keeps its tempo and removes the previous duration unit. A line beginning with a literal bracket must start with `\[`.

Place the cursor in the lyrics or select text to reveal **Add a tag** nearby. Hover over it, tap it, or press Tab to expand the choices: **Section**, **Line timing**, **Timing passage** and **Pause**. The chosen indication applies to the current line, or to the selected lines for a timing passage. Escape dismisses the shortcut; the toolbar above the lyrics is also available.

Invalid timing indications are listed with their line number. You can keep your draft while correcting them. Indications disappear from the prompter; section headings remain visible. Update LyricFlow before reading a shared song that requires newer timing features.

## Read

Choose **Open prompter**. In musical mode, choose **Line by line** or **Continuous** movement. In **Pixels per second** mode, the movement has a constant visual speed. All three pause types work in either mode.

Choose **Start**, **Pause** or **Resume**. Tap a lyric line to restart from that line. Change **Song BPM** at any time: elapsed musical beats are preserved. Change text size to suit your screen. **Restart** returns to the beginning and waits for you to start again.

Scroll the lyrics before starting, while paused or after the song ends, using touch, a mouse wheel or the keyboard when the lyrics area is focused. Scrolling only changes what you see: **Resume** returns to the suspended line and its remaining time. Tap a line to choose a different point. Manual scrolling is locked during playback, the count-in and timed musical waits.

Musical pauses show their remaining beats, including pauses written in bars. Pauses written in seconds show their remaining time.

The active line also has a countdown on its left. In BPM mode, the fraction shows beats above bars: two four-beat bars count down `4/2`, `3/2`, `2/2`, `1/2`, then `4/1` through `1/1`. Timed musical waits use the same fraction. In pixels mode, the indicator shows seconds based on the scrolling distance and speed; waits written in seconds always show seconds. Values round up to whole numbers without changing playback timing. **Pause** shows the full duration; **Resume** restores the actual remaining countdown. The opening count-in does not consume the first line, and the indicator disappears at the end.

The visual metronome shows one light per beat, using **Beats per bar** (four lights for four beats, six for six). Each light briefly glows in turn at the passage’s effective BPM, including during timed waits and in pixels mode. It stays visible in the expanded reader. Pause or leaving the app turns the lights off; Resume continues the beat position. Tapping a line or restarting resets the cycle to the first light. The count-in also shows the lights, then starts the lyrics on the first light. This metronome is silent.

During playback and count-in, the prompter expands to use the available screen width and gives more space to the lyrics by folding away the title, status summary, reading hint, music links and Share link button. Playback controls, settings, library and theme buttons remain available, and sound errors still appear during the count-in. The screen-lock status appears below the controls when playback is stopped. During playback, a screen-lock problem brings up **Keep screen awake** in the header. Pausing, restarting or reaching the end restores the usual layout. The transition is animated unless your device requests reduced motion.

The optional count-in shows the remaining beats and follows the opening passage’s tempo, including fixed or percentage indications. Enable **Audible count-in** for a click; it is only played during the count-in. The visual count-in continues even if sound is unavailable. Set count-in beats to `0` to start immediately.

Leaving the app or locking your phone pauses the reading. Return and tap **Resume** when ready. LyricFlow asks the browser to keep the screen awake for the entire time the reading page is visible: before Start, during pauses and after the song ends. Leaving the reader or putting the app in the background releases the request; returning requests it again without resuming playback. **Screen kept awake** confirms an active lock. If it is unavailable or released by the browser, an explanation and **Keep screen awake** retry button appear. Browser support, battery-saving settings and device policy can prevent the lock.

## Offline and appearance

Open the app online once and wait until it is ready offline. You can then reload, edit and read saved songs without a connection. The sun/moon button switches the whole app between light and dark mode and saves the choice on this device.

Songs are stored in this browser’s site data. Clearing that data removes local songs and pending changes. Only account-profile data already confirmed by **Synced** can be restored from the server. Guest songs have no online backup. If saving fails, keep the editor open and copy your lyrics before leaving it.

If your current version only asks you to close all tabs, do this once to receive the version with **Update now**.

When an app update is ready, choose **Update now** in your library or editor. Libraries in all open tabs reload, and editors save their latest draft on this device before reloading. A failed save keeps the editor open so you can retry **Update now**. Readers stay open while stopped, playing or paused; account, community, sharing and administration screens also wait until you return to your library. Closing the update notice hides it without preventing a later update applied from another tab. Updating does not wait for online synchronization. Your songs, profiles and preferences stay on this device. No advertisements are displayed.


## Sharing and the community

From your signed-in profile, **Share song** previews the saved lyrics and musical timing. Unfinished drafts stay private. Check the title/artist suggestions and sharing information, then confirm publication. Personal display settings, sound and email are excluded. Each publication starts at **V.1**; **Publish saved changes** creates the next revision only when its public content changes. **Withdraw publication** removes it from online access while existing private copies remain available. Publish it again from the same saved song to restore its identity and reviews.

Shared songs have a **Shared** badge in your library and editor. **Automatically share saved changes** is checked by default and follows your account across devices. With it checked, **Save song** and **Open prompter** update the public version. Autosaved drafts and changes made directly in the reader stay private. Uncheck it to keep future saved changes private and cancel pending automatic updates. Checking it alone does not publish any content.

Saved offline changes show **Sharing changes pending** and are sent after reconnection and private backup. A sharing error does not undo your private save; use **Sync now** to retry network failures. If another device changed the public version or sharing conditions, automatic updates stop: use **Share song** to review and publish manually. Private conflicts also pause automatic sharing; after resolving them, save again to create a new public update. Hidden or withdrawn publications are not automatically restored. If this device has never loaded the song’s shared status, reconnect before saving changes to publish automatically.

**Community** searches by title or artist and groups shared versions of each song. Versions are ordered by average stars, review count, then versions without reviews. **Save a private copy** creates your own editable, offline copy. Adaptations can be shared with a visible reference to their source.

In your library, **Check for updates** shows newer source revisions. **Update from source** updates an unchanged copy and keeps your personal display settings. If you have edited its lyrics, music links, musical timing or draft, keep the adaptation or choose **Download new copy**. Nothing is merged automatically. A source becoming unavailable never deletes your private copy.

Reviews require a whole number from **0 to 5** stars; a comment is optional. You can edit or remove your one review per publication, and cannot rate your own publication. **No ratings yet** differs from a real zero average. Reviews keep the revision they were written for after a public update.

Use **Report publication**, **Report user**, **Report comment**, or **Request removal** for a takedown request. Reports are reviewed by moderators and do not automatically remove content. First-time publication, reviews, reports and moderation need an online session. Saved changes to an already shared song can wait offline as explained above.

Deleting your account lets you select publications to keep under **Anonymous**. Their revisions and received reviews stay; other publications and your own emitted reviews are removed. The separate local-data choice still applies.

## Moderation and administration

Accounts with the appropriate role can open **Moderation**. Review open reports, assign a status and decision, then use the target’s moderation action to hide/restore public content or ban/unban an account with a reason. Hiding a comment keeps its stars. Banning hides all of that account’s publications; unbanning preserves individual content restrictions.

Administrators additionally manage users and roles, correct or merge catalog entries, and pause new publishing or reviews through **Service settings**. Private songs remain accessible only to their owner. Assign another active administrator before removing the last one. A server operator must grant the first administrator; registration never grants management permissions.

## Supporting LyricFlow

Open **Support** from your library or the footer to see the annual funding goal and make a one-off euro donation through Stripe, when donations are configured. You choose the amount, and an account is optional. Sign in before donating to have your Supporter badge linked automatically. Confirmation can take a few minutes; return to the support page and choose **Refresh** to see the latest status. The badge does not unlock features or priority access.

Your support is private by default. Once your donation is confirmed, choose **Show my support on the wall** to display your pseudonym, or **Hide my support** to remove it. Individual amounts are never shown on the public wall. If you donated without signing in, keep your Stripe receipt so the operator can verify and link it later. Do not share a personalized donation link; share the support page instead.

The funding total includes confirmed donations for the current calendar year in UTC, less refunds and before Stripe fees. It starts fresh in January; your badge remains while at least one linked donation has a positive amount after refunds. Administrators can see the private donation history on the support page.

## Share a prompter link

Choose **Share link** in the prompter to copy a link to the latest published version. Anyone with the link can open its prompter without an account. If your saved song differs from the public version, choose **Copy public link** or **Share song** to review and publish your changes first. A song that has never been published requires an active account and the sharing confirmation. Guest songs can be copied to your account after signing in; sharing a link never moves them automatically.

Opening a link does not add a song to your library. Playback settings are temporary and reset when you reload. Opening or reloading a link requires a network connection. Withdrawal, moderation or an unavailable publication prevents future loads. If clipboard access is refused, select and copy the displayed link manually.

## Scores and instrumental songs

In the song editor, **Scores → New arrangement** opens a separate score workspace. Name each arrangement and choose its own tempo, time signature and major/minor key. Add any number of arrangements within the technical size limit. Tracks can be six-string guitar, four-string bass (standard tuning), piano or drums; several tracks may use the same instrument. Rename, duplicate or confirm deletion in the Scores list.

Choose a track, staff, measure and voice. Select an event in the event list or printed score, then apply its duration, dots or triplet setting. **Append note** and **Append rest** extend the voice; **Insert note/rest after selected event** edits a position inside the measure; **Add note to selected chord** adds a simultaneous note. Guitar/bass input uses string (1 = highest) and fret, or pitch with an automatically chosen playable position. Piano uses pitch, octave and accidental on the selected staff. Drums use the drum-piece selector. A tie continues the same note in the next event. Use three equal undotted events for a triplet group. **Fill remaining time with rests** completes unused measure time. Measures affect every track; passage copies are appended. Undo/Redo retains the last 50 editing steps while the workspace is open.

Drafts save automatically, even when measures are incomplete. Check the save status before closing the page. Musical errors remain editable but prevent listening and publishing; each voice must fill its measure exactly. If a technical limit rejects a command, the previous draft is kept. A device storage failure keeps the latest edit on screen: free space and retry before closing. **Back to song** keeps the draft; **Save song** commits it. You can leave lyrics blank for an instrumental.

Open **Scores** from the library, a public version or a public song link. The score reader is separate from the lyrics prompter. Play/resume starts sound only after your action; Pause, Stop and Go to measure control playback. Choose the first/last measures and **Loop passage** for practice. Zoom and switch between standard notation, tablature or both. Expand **Visible tracks and sound** for track visibility, sound, volume and solo. Hiding a track does not mute it. Collapse panels on a small screen to make room for the score. Going into the background pauses sound.

Private sync, public copies and revisions include all arrangements together with the song. Source updates protect your musical adaptations. Finish the first online installation before using sounds offline. Scores cannot yet import/export files, recognize PDFs/recordings, change tuning or synchronize with lyrics. [Technical format, deployment and device checks](PARTITIONS.md) are documented in French.
