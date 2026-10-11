"""Read a bounded batch of Legalmail PEC messages without changing mailbox flags.

Protocol on stdin/stdout is one JSON object. Credentials are read only from the
environment; neither exceptions nor mail contents are printed to diagnostics.
"""

import base64
import email
from email import policy
from email.parser import BytesParser
import imaplib
import io
import json
import os
import re
import ssl
import sys
import zipfile

MAX_MESSAGE = 6_000_000
MAX_XML = 2_000_000
MAX_MESSAGES = 5
MAX_PARTS = 100
MAX_XML_FILES = 20
MAX_ZIP = 3_000_000


class PecIssue(Exception):
    def __init__(self, code):
        self.code = code


def safe_name(value):
    name = (value or "fattura.xml").replace("\\", "/").split("/")[-1]
    name = "".join(c for c in name if 32 <= ord(c) < 127 and c not in '<>:"|?*')
    if name.lower().endswith(".xml"):
        return (name[:-4][:176] or "fattura") + ".xml"
    return name[:180] or "fattura.xml"


def xml_attachment(name, content):
    if not content or len(content) > MAX_XML:
        raise PecIssue("PEC_XML_SIZE")
    return {"filename": safe_name(name), "base64": base64.b64encode(content).decode("ascii")}


def extract_xml(raw):
    """Extract XML attachment bytes from a PEC envelope, including postacert.eml."""
    if not isinstance(raw, bytes) or not raw or len(raw) > MAX_MESSAGE:
        raise PecIssue("PEC_MESSAGE_SIZE")
    message = BytesParser(policy=policy.default).parsebytes(raw)
    files, issues, part_count = [], [], 0

    def add_file(name, content):
        if len(files) >= MAX_XML_FILES:
            raise PecIssue("PEC_ATTACHMENT_LIMIT")
        files.append(xml_attachment(name, content))

    def examine_zip(data):
        if len(data) > MAX_ZIP:
            raise PecIssue("PEC_ZIP_SIZE")
        try:
            with zipfile.ZipFile(io.BytesIO(data)) as archive:
                entries = archive.infolist()
                if len(entries) > MAX_XML_FILES:
                    raise PecIssue("PEC_ZIP_ENTRY_LIMIT")
                for entry in entries:
                    name = entry.filename.replace("\\", "/")
                    if (name.startswith("/") or ":" in name or
                            any(p in ("", ".", "..") for p in name.split("/")) or
                            entry.flag_bits & 1):
                        raise PecIssue("PEC_ZIP_ENTRY_UNSAFE")
                    if entry.is_dir():
                        continue
                    if not name.lower().endswith(".xml"):
                        continue
                    if entry.file_size > MAX_XML or entry.file_size > max(entry.compress_size, 1) * 100:
                        raise PecIssue("PEC_ZIP_EXPANSION")
                    with archive.open(entry) as stream:
                        content = stream.read(MAX_XML + 1)
                    if len(content) != entry.file_size:
                        raise PecIssue("PEC_ZIP_SIZE_MISMATCH")
                    add_file(name, content)
        except (zipfile.BadZipFile, OSError):
            raise PecIssue("PEC_ZIP_INVALID")

    def visit(part, depth):
        nonlocal part_count
        part_count += 1
        if depth > 8 or part_count > MAX_PARTS:
            raise PecIssue("PEC_MIME_COMPLEXITY")
        kind = part.get_content_type().lower()
        name = part.get_filename()
        if kind == "message/rfc822":
            payload = part.get_payload()
            if isinstance(payload, list):
                for nested in payload:
                    visit(nested, depth + 1)
            else:
                data = part.get_payload(decode=True)
                if data and len(data) <= MAX_MESSAGE:
                    visit(BytesParser(policy=policy.default).parsebytes(data), depth + 1)
            return
        if part.is_multipart():
            for child in part.iter_parts():
                visit(child, depth + 1)
            return
        if not name:
            if kind in ("application/pkcs7-mime", "application/x-pkcs7-mime"):
                issues.append("PEC_SIGNED_FILE_UNSUPPORTED")
            elif kind in ("application/xml", "text/xml"):
                data = part.get_payload(decode=True)
                if isinstance(data, bytes):
                    add_file("allegato.xml", data)
                else:
                    issues.append("PEC_ATTACHMENT_INVALID")
            return
        lower = name.replace("\\", "/").split("/")[-1].lower()
        # Standard PEC envelopes carry certification metadata as daticert.xml.
        # It is not a supplier invoice and must not become a false import error.
        if lower == "daticert.xml":
            return
        if not lower.endswith((".xml", ".zip", ".xml.p7m", ".p7m", ".eml")):
            return
        data = part.get_payload(decode=True)
        if not isinstance(data, bytes):
            issues.append("PEC_ATTACHMENT_INVALID")
            return
        if lower.endswith(".eml"):
            if len(data) > MAX_MESSAGE:
                raise PecIssue("PEC_MESSAGE_SIZE")
            visit(BytesParser(policy=policy.default).parsebytes(data), depth + 1)
        elif lower.endswith(".xml"):
            add_file(name, data)
        elif lower.endswith(".zip"):
            examine_zip(data)
        else:
            issues.append("PEC_SIGNED_FILE_UNSUPPORTED")

    visit(message, 0)
    return {"files": files, "issues": sorted(set(issues))}


def parse_size(result):
    if result[0] != "OK":
        raise PecIssue("PEC_FETCH_FAILED")
    for item in result[1] or []:
        if isinstance(item, bytes):
            match = re.search(rb"\bRFC822\.SIZE\s+(\d+)\b", item)
            if match:
                return int(match.group(1))
        elif isinstance(item, tuple) and isinstance(item[0], bytes):
            match = re.search(rb"\bRFC822\.SIZE\s+(\d+)\b", item[0])
            if match:
                return int(match.group(1))
    raise PecIssue("PEC_FETCH_FAILED")


def poll(request):
    username = os.environ.get("PEC_USER", "")
    password = os.environ.get("PEC_APP_PASSWORD", "")
    if not username or not password:
        raise PecIssue("PEC_NOT_CONFIGURED")
    host = os.environ.get("PEC_HOST", "mbox.cert.legalmail.it")
    port_text = os.environ.get("PEC_PORT", "993")
    if not port_text.isdigit():
        raise PecIssue("PEC_CONFIG_INVALID")
    port = int(port_text)
    mailbox = os.environ.get("PEC_MAILBOX", "INBOX")
    if not re.fullmatch(r"[A-Za-z0-9.-]{1,253}", host) or not 1 <= port <= 65535:
        raise PecIssue("PEC_CONFIG_INVALID")
    if not re.fullmatch(r"[A-Za-z0-9 _.-]{1,80}", mailbox):
        raise PecIssue("PEC_CONFIG_INVALID")
    previous_validity = str(request.get("uidvalidity") or "")
    last_uid = request.get("lastUid", 0)
    if not isinstance(last_uid, int) or last_uid < 0:
        raise PecIssue("PEC_CURSOR_INVALID")
    connection = None
    try:
        connection = imaplib.IMAP4_SSL(host, port, ssl_context=ssl.create_default_context(), timeout=20)
        try:
            login_result = connection.login(username, password)
        except imaplib.IMAP4.error:
            raise PecIssue("PEC_LOGIN_FAILED")
        if login_result[0] != "OK":
            raise PecIssue("PEC_LOGIN_FAILED")
        if connection.select(mailbox, readonly=True)[0] != "OK":
            raise PecIssue("PEC_MAILBOX_UNAVAILABLE")
        response = connection.response("UIDVALIDITY")
        validity_values = response[1] or []
        validity = validity_values[0].decode("ascii") if validity_values else ""
        if not re.fullmatch(r"[1-9][0-9]*", validity):
            raise PecIssue("PEC_UIDVALIDITY_MISSING")
        reset = bool(previous_validity and previous_validity != validity)
        cursor = 0 if reset else last_uid
        # UID n:* may include the final old message when n exceeds UIDNEXT.
        found = connection.uid("SEARCH", None, "UID", f"{cursor + 1}:*")
        if found[0] != "OK" or not found[1] or not isinstance(found[1][0], bytes) or len(found[1][0]) > 200_000:
            raise PecIssue("PEC_SEARCH_FAILED")
        uids = []
        for token in found[1][0].split():
            if not token.isdigit():
                raise PecIssue("PEC_SEARCH_FAILED")
            uid = int(token)
            if uid > cursor:
                uids.append(uid)
        uids = sorted(set(uids))
        messages = []
        for uid in uids[:MAX_MESSAGES]:
            row = {"uid": uid, "files": [], "issues": []}
            try:
                size = parse_size(connection.uid("FETCH", str(uid), "(RFC822.SIZE)"))
                if size > MAX_MESSAGE:
                    row["issues"].append("PEC_MESSAGE_SIZE")
                else:
                    fetched = connection.uid("FETCH", str(uid), "(BODY.PEEK[])" )
                    if fetched[0] != "OK":
                        raise PecIssue("PEC_FETCH_FAILED")
                    chunks = [item[1] for item in (fetched[1] or []) if isinstance(item, tuple) and isinstance(item[1], bytes)]
                    if len(chunks) != 1 or len(chunks[0]) > MAX_MESSAGE:
                        raise PecIssue("PEC_FETCH_FAILED")
                    row.update(extract_xml(chunks[0]))
            except PecIssue as issue:
                row["issues"].append(issue.code)
            messages.append(row)
        return {"uidvalidity": validity, "reset": reset, "messages": messages,
                "more": len(uids) > MAX_MESSAGES}
    except (imaplib.IMAP4.error, OSError, TimeoutError):
        raise PecIssue("PEC_CONNECTION_FAILED")
    finally:
        if connection is not None:
            try:
                connection.logout()
            except Exception:
                pass


def main():
    try:
        raw = sys.stdin.buffer.read(2_000_001)
        if len(raw) > 2_000_000:
            raise PecIssue("PEC_INPUT_LIMIT")
        request = json.loads(raw)
        if request.get("action") == "extract":
            result = extract_xml(base64.b64decode(request["base64"], validate=True))
        elif request.get("action") == "poll":
            result = poll(request)
        else:
            raise PecIssue("PEC_ACTION_INVALID")
        sys.stdout.write(json.dumps({"ok": True, "result": result}, separators=(",", ":")))
    except PecIssue as issue:
        sys.stdout.write(json.dumps({"ok": False, "code": issue.code}))
        sys.exit(1)
    except Exception:
        sys.stdout.write('{"ok":false,"code":"PEC_INTERNAL"}')
        sys.exit(1)


if __name__ == "__main__":
    main()
