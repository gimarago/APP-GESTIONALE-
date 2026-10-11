package it.magomme.documents

import android.app.Activity
import android.content.ClipData
import android.content.Intent
import android.os.CancellationSignal
import android.os.ParcelFileDescriptor
import android.print.PrintAttributes
import android.print.PrintDocumentAdapter
import android.print.PrintManager
import android.util.Base64
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.activity.result.ActivityResult
import androidx.core.content.FileProvider
import app.tauri.annotation.ActivityCallback
import app.tauri.annotation.Command
import app.tauri.annotation.InvokeArg
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin
import java.io.ByteArrayInputStream
import java.io.File
import java.util.UUID
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean

@InvokeArg
class ExportArgs { lateinit var name: String; lateinit var mime: String; lateinit var base64: String }
@InvokeArg
class PrintArgs {
    lateinit var html: String
    lateinit var title: String
    var labelWidthMm: Double? = null
    var labelHeightMm: Double? = null
}

@TauriPlugin
class DocumentsPlugin(private val activity: Activity) : Plugin(activity) {
    private val busy = AtomicBoolean(false)
    private val io = Executors.newSingleThreadExecutor()
    private var printing: WebView? = null

    private fun result(status: String) = JSObject().apply { put("status", status) }
    private fun claim(invoke: Invoke): Boolean {
        if (busy.compareAndSet(false, true)) return true
        invoke.reject("Chiudi prima il documento già aperto.")
        return false
    }

    @Command
    fun exportDocument(invoke: Invoke) {
        if (!claim(invoke)) return
        val args = try { invoke.parseArgs(ExportArgs::class.java) } catch (e: Exception) {
            busy.set(false); invoke.reject("Documento non valido."); return
        }
        io.execute {
            try {
                require(args.name.isNotBlank() && args.name.length <= 180 && args.name == File(args.name).name &&
                    !args.name.startsWith(".") && !args.name.any { it.code < 32 || "<>:\"/\\|?*".contains(it) })
                require(args.base64.length <= 44_739_244)
                val bytes = Base64.decode(args.base64, Base64.NO_WRAP)
                require(bytes.size <= 32 * 1024 * 1024)
                val root = File(activity.cacheDir, "officina-exports").apply { mkdirs() }
                // Delete only plugin-owned old export folders. Never remove an in-flight file.
                val cutoff = System.currentTimeMillis() - 24 * 60 * 60 * 1000
                root.listFiles()?.filter { it.isDirectory && it.lastModified() < cutoff }?.forEach { it.deleteRecursively() }
                val directory = File(root, UUID.randomUUID().toString()).apply { mkdir() }
                val file = File(directory, args.name)
                file.outputStream().use { it.write(bytes) }
                activity.runOnUiThread {
                    try {
                        val uri = FileProvider.getUriForFile(activity, "${activity.packageName}.officina.documents", file)
                        val send = Intent(Intent.ACTION_SEND).apply {
                            type = args.mime
                            putExtra(Intent.EXTRA_STREAM, uri)
                            addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
                            clipData = ClipData.newRawUri(args.name, uri)
                        }
                        startActivityForResult(invoke, Intent.createChooser(send, "Salva o condividi documento"), "shareFinished")
                    } catch (e: Exception) {
                        busy.set(false); invoke.reject("Impossibile aprire la condivisione del documento.")
                    }
                }
            } catch (e: Exception) {
                busy.set(false); invoke.reject("Documento non valido o impossibile da preparare.")
            }
        }
    }

    @ActivityCallback
    fun shareFinished(invoke: Invoke, outcome: ActivityResult) {
        busy.set(false)
        // Android share targets do not reliably report delivery or cancellation.
        invoke.resolve(result("presented"))
    }

    @Command
    fun printDocument(invoke: Invoke) {
        if (!claim(invoke)) return
        try {
            val args = invoke.parseArgs(PrintArgs::class.java)
            require(args.html.toByteArray(Charsets.UTF_8).size <= 5 * 1024 * 1024 && args.title.length <= 180)
            val web = WebView(activity)
            printing = web
            web.settings.apply {
                javaScriptEnabled = false
                allowFileAccess = false
                allowContentAccess = false
                blockNetworkLoads = true
                loadsImagesAutomatically = true
            }
            var submitted = false
            web.webViewClient = object : WebViewClient() {
                override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean = true
                override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? {
                    if (request.url.scheme == "data") return null
                    return WebResourceResponse("text/plain", "utf-8", ByteArrayInputStream(ByteArray(0)))
                }
                override fun onPageFinished(view: WebView, url: String) {
                    if (submitted) return
                    submitted = true
                    try {
                        val delegate = view.createPrintDocumentAdapter(args.title)
                        val adapter = object : PrintDocumentAdapter() {
                            override fun onStart() { delegate.onStart() }
                            override fun onLayout(oldAttributes: PrintAttributes?, newAttributes: PrintAttributes?, cancellationSignal: CancellationSignal?, callback: LayoutResultCallback?, extras: android.os.Bundle?) {
                                delegate.onLayout(oldAttributes, newAttributes, cancellationSignal, callback, extras)
                            }
                            override fun onWrite(pages: Array<android.print.PageRange>?, destination: ParcelFileDescriptor?, cancellationSignal: CancellationSignal?, callback: WriteResultCallback?) {
                                delegate.onWrite(pages, destination, cancellationSignal, callback)
                            }
                            override fun onFinish() {
                                delegate.onFinish()
                                releasePrint()
                                invoke.resolve(result("presented"))
                            }
                        }
                        val attributes = PrintAttributes.Builder()
                        if (args.labelWidthMm != null && args.labelHeightMm != null) {
                            val width = args.labelWidthMm!!
                            val height = args.labelHeightMm!!
                            require(width.isFinite() && height.isFinite() && width in 30.0..216.0 && height in 20.0..600.0)
                            attributes.setMediaSize(PrintAttributes.MediaSize("officina-label", "Etichetta", (width * 1000 / 25.4).toInt(), (height * 1000 / 25.4).toInt()))
                            attributes.setMinMargins(PrintAttributes.Margins.NO_MARGINS)
                        }
                        (activity.getSystemService(Activity.PRINT_SERVICE) as PrintManager)
                            .print(args.title, adapter, attributes.build())
                    } catch (e: Exception) {
                        releasePrint(); invoke.reject("Stampa non disponibile su questo dispositivo.")
                    }
                }
            }
            // HTML is sanitized by Rust before this native command is called. No JS bridge is installed.
            web.loadDataWithBaseURL(null, args.html, "text/html", "UTF-8", null)
        } catch (e: Exception) {
            releasePrint(); invoke.reject("Documento di stampa non valido.")
        }
    }

    private fun releasePrint() {
        printing?.destroy()
        printing = null
        busy.set(false)
    }
}
