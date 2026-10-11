# Aggiornamenti Windows senza reinstallazione manuale

La versione Windows **1.0.3** introduce il pulsante **Aggiornamenti**. Dopo la prima installazione manuale di questa versione e l’aggiornamento del VPS, le release successive possono essere cercate, scaricate e installate direttamente dall’app. Non è necessario cercare il nuovo setup nel browser.

Il pulsante rimane disponibile anche sulla schermata di accesso o sul launcher locale. Il download è separato dall’installazione: si può continuare a lavorare e installare quando le schede sono state salvate e chiuse. L’installazione conferma prima i salvataggi e poi riavvia l’app. In presenza di moduli aperti, bozze, conflitti o assenza di rete, il riavvio viene annullato.

## Preparare una nuova release

Occorrono i prerequisiti della compilazione Windows descritti nel README e la chiave privata originale con la relativa password. La chiave pubblica è inclusa in `src-tauri/tauri.conf.json`; non sostituirla dopo la distribuzione, altrimenti i PC esistenti non potranno verificare le nuove release.

1. Aumentare insieme la versione in `package.json`, `package-lock.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml` e la voce `officina-app` di `src-tauri/Cargo.lock`.
2. In PowerShell, dalla cartella `gestionale-app`, indicare la cartella privata di firma e compilare:

```powershell
$taskSigningDir = 'C:\percorso\privato\Officina-Aggiornamenti-firma-privata'
$env:TAURI_SIGNING_PRIVATE_KEY = Join-Path $taskSigningDir 'officina-updater.key'
$env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = [System.IO.File]::ReadAllText((Join-Path $taskSigningDir 'password.txt')).Trim()
try {
    npm ci
    npm run build:windows
} finally {
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY
    Remove-Item Env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD
}
```

La CLI Tauri inclusa genera l’installer e `.exe.sig` in `src-tauri/target/release/bundle/nsis/`. La firma deve includere il numero di versione nel commento firmato: la CLI 2.12.1 del progetto lo aggiunge durante la compilazione. Non utilizzare `--no-sign` e non ricompilare la release con un’altra chiave.

3. Preparare i file pubblici del server. Lo script trova automaticamente l’installer della versione corrente; è possibile indicare esplicitamente `--installer` e `--signature`. Un file di note UTF-8 è facoltativo:

```powershell
npm run release:windows -- --release-dir '..\gestionale-vps\app-updates\windows-x86_64'
# Facoltativo: aggiungere --notes-file 'note-aggiornamento.txt'
```

Lo script controlla il formato dell’installer e della firma, il numero di versione firmato e la dimensione; rifiuta di sostituire un pacchetto diverso con la stessa versione. Copia l’installer, la firma e aggiorna `latest.json` per ultimo. La verifica crittografica definitiva viene effettuata dall’app prima dell’installazione.

4. Pubblicare sul VPS i file della directory di release come descritto in `gestionale-vps/AGGIORNAMENTI-APP.md`. La nuova versione deve essere maggiore di quella installata sui PC. Il manifest contiene indirizzo HTTPS, versione, data, note e firma del pacchetto.

## Conservare la firma

La chiave di produzione di questa consegna e la password sono conservate separatamente in `outputs/Officina-Aggiornamenti-firma-privata`, escluse dagli ZIP e dal Git. Fare subito un backup privato di **tutta la cartella**, compresa la password. Senza la chiave originale non è possibile pubblicare aggiornamenti accettati dai PC già installati.

Non caricare questa cartella sul VPS, non inviarla ai clienti e non inserirla nei sorgenti pubblici. La firma Tauri protegge l’aggiornamento; non costituisce un certificato commerciale Windows.

## Verifiche disponibili

`npm test` verifica il bridge e il pannello degli aggiornamenti nel browser con comandi nativi simulati. `cargo test --manifest-path src-tauri/Cargo.toml --lib` prova le politiche e il protocollo reale dell’updater, inclusi firma alterata e versione firmata incompatibile, senza installare i pacchetti di prova. Nel VPS, `npm run test:app-update-save` verifica la conferma dei salvataggi; `npm run test:app-update-release` verifica i file pubblici della release reale in un server temporaneo.

L’installazione e il riavvio dell’app su un PC dell’officina devono essere verificati alla prima distribuzione. Queste prove non modificano il VPS operativo e non sostituiscono tale collaudo.
