# Restoring Firestore

The shared database is Firestore `(default)` of project `tieryourlife`, in
`europe-west1`, Standard edition. Danylo decided on 15.11.2026 ("Да, включи")
to protect it in three ways and nothing more:

1. **Point-in-time recovery (PITR)**: every version of every document is kept
   for 7 days, readable at any minute in that window.
2. **A daily managed backup**, each kept for 7 days.
3. **Delete protection**: the database itself cannot be deleted while it is on.

Turning any of these off, changing the retention, or restoring over `(default)`
is Danylo's call. A restore always goes into a **new** database first, is
compared there, and only the documents that need it are copied back.

## Check what is on

```bash
gcloud firestore databases describe --database="(default)" --project=tieryourlife --format="yaml(pointInTimeRecoveryEnablement,deleteProtectionState,earliestVersionTime,versionRetentionPeriod)"
```

```bash
gcloud firestore backups schedules list --database="(default)" --project=tieryourlife
```

```bash
gcloud firestore backups list --location=europe-west1 --project=tieryourlife
```

Expected: `POINT_IN_TIME_RECOVERY_ENABLED`, `DELETE_PROTECTION_ENABLED`,
`versionRetentionPeriod: 604800s`, `earliestVersionTime` about 7 days back
(right after PITR is switched on it starts from that moment), one daily
schedule with `retention: 604800s`, and a backup for each of the last days
(the first one within a day of the schedule being made).

How they were switched on:

```bash
gcloud firestore databases update --database="(default)" --project=tieryourlife --enable-pitr --delete-protection
```

```bash
gcloud firestore backups schedules create --database="(default)" --project=tieryourlife --recurrence=daily --retention=7d
```

## A few documents, from a moment in the last 7 days (PITR)

For one board, list or account that went wrong, read the documents as they
were and write back only those. The Admin SDK reads the past in a read-only
transaction with `readTime` (a whole minute when it is more than an hour back):

```js
const { createRequire } = require("node:module");
const require2 = createRequire("D:/MyProjects/TierYourLife/TierYourLifeProxy/functions/package.json");
const { initializeApp, applicationDefault } = require2("firebase-admin/app");
const { getFirestore, Timestamp } = require2("firebase-admin/firestore");
initializeApp({ credential: applicationDefault(), projectId: "tieryourlife" });
const db = getFirestore();
const at = Timestamp.fromDate(new Date("2026-11-15T01:20:00Z"));
const then = await db.runTransaction((t) => t.get(db.collection("accounts/UID/boards")), { readOnly: true, readTime: at });
```

Save what was read to `backups\<task>\` first, as JSON, together with what is
there now. Write back only after the owner of the data and the coordinator
agree, and with the boards' rules in mind: a board PUT over a deletion marker
needs `basedOn` equal to the marker's revision, so a restored board goes back
with a revision above the marker's.

For more than a few documents, clone the whole database as it was into a new
one and read from there:

```bash
gcloud firestore databases clone --project=tieryourlife --source-database="projects/tieryourlife/databases/(default)" --snapshot-time=2026-11-15T01:20:00Z --destination-database=restore-20261115
```

## From a daily backup

Older than PITR reaches, or when the backup is the cleaner moment:

```bash
gcloud firestore backups list --location=europe-west1 --project=tieryourlife
```

```bash
gcloud firestore databases restore --project=tieryourlife --source-backup=projects/tieryourlife/locations/europe-west1/backups/BACKUP_ID --destination-database=restore-20261115
```

The restore makes a new database (it takes minutes for this size, about 35 MB).
Read from it with the Admin SDK by naming it, `getFirestore("restore-20261115")`,
compare, and copy back only the documents that need it.

## Afterwards

A restored database costs storage like any other. Deleting it is a deletion,
so it waits for Danylo's word:

```bash
gcloud firestore databases delete --database=restore-20261115 --project=tieryourlife
```

Report what was restored, from which moment, which documents were written back,
and where the saved JSON is.
