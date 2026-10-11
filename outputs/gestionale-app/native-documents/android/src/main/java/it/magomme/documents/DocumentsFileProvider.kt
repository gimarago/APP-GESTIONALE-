package it.magomme.documents

import androidx.core.content.FileProvider

// A distinct provider name keeps manifest merging separate from Tauri's provider.
class DocumentsFileProvider : FileProvider()
