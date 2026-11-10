# Music runtime RLS verification

The runtime verifier uses only the project URL, the browser-safe anon/publishable key, and two normal disposable user sessions. It never uses a service-role key.

Add these variable names to the local, Git-ignored `.env.local` file after creating two ordinary users through `/auth`:

```text
MEDCLIP_TEST_USER_A_EMAIL=
MEDCLIP_TEST_USER_A_PASSWORD=
MEDCLIP_TEST_USER_B_EMAIL=
MEDCLIP_TEST_USER_B_PASSWORD=
```

Do not add real test credentials to `.env.example` or commit `.env.local`.

Run from the repository root:

```powershell
pnpm.cmd verify:music-rls
```

Without all four test-user variables, the command exits without contacting Auth or changing data and reports `RUNTIME RLS TEST = READY, NOT RUN`.

With both disposable accounts configured, the script checks anonymous, User A, and User B database and private Storage behavior. It creates one temporary User A draft, uploads a tiny test object, publishes the track, verifies published access, then attempts to remove the object and row. Any cleanup failure is reported and sets a failing exit status.
