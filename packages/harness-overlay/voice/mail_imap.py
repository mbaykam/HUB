"""Read-only Gmail access over IMAP with the Python standard library.

The job arrives on stdin (never argv, so the password is not visible in the
process list). Mailboxes are opened with EXAMINE and bodies fetched with
BODY.PEEK, so nothing is marked read, moved or changed. This worker cannot
send mail: sending happens on the user's iPhone.
"""
import email
import html
import imaplib
import json
import re
import sys
from email.policy import default as default_policy
from email.utils import parsedate_to_datetime

HOST = 'imap.gmail.com'
MAX_RESULTS = 25
MAX_BODY = 20000


def quoted(name):
    return '"' + name.replace('\\', '\\\\').replace('"', '\\"') + '"'


def special_folder(imap, flag):
    """Gmail localises folder names ("[Gmail]/Tüm Postalar"); find them by flag."""
    status, lines = imap.list()
    if status != 'OK':
        return None
    for raw in lines or []:
        line = raw.decode('utf-8', 'replace') if isinstance(raw, bytes) else str(raw)
        if flag in line:
            match = re.search(r'"([^"]+)"\s*$', line) or re.search(r'(\S+)\s*$', line)
            if match:
                return match.group(1)
    return None


def mailbox(imap, folder):
    folder = (folder or 'inbox').strip()
    named = {'all': '\\All', 'sent': '\\Sent', 'spam': '\\Junk', 'trash': '\\Trash', 'starred': '\\Flagged', 'important': '\\Important'}
    if folder.lower() in named:
        return special_folder(imap, named[folder.lower()]) or 'INBOX'
    return 'INBOX' if folder.lower() == 'inbox' else folder


def decoded_header(message, name):
    value = message.get(name)
    return str(value)[:500] if value is not None else ''


def text_of(message):
    part = message.get_body(preferencelist=('plain', 'html'))
    if part is None:
        return ''
    try:
        content = part.get_content()
    except Exception:
        payload = part.get_payload(decode=True) or b''
        content = payload.decode(part.get_content_charset() or 'utf-8', 'replace')
    if part.get_content_type() == 'text/html':
        content = re.sub(r'(?is)<(script|style).*?</\1>', ' ', content)
        content = re.sub(r'(?i)<br\s*/?>|</p>|</div>|</li>|</tr>', '\n', content)
        content = html.unescape(re.sub(r'<[^>]+>', ' ', content))
    content = re.sub(r'[ \t ]+', ' ', content)
    content = re.sub(r'\n\s*\n\s*\n+', '\n\n', content)
    return content.strip()


def attachments_of(message):
    names = []
    for part in message.iter_attachments():
        name = part.get_filename()
        if name:
            names.append({'name': str(name)[:200], 'type': part.get_content_type()})
    return names[:30]


def iso_date(message):
    try:
        return parsedate_to_datetime(message.get('Date')).isoformat()
    except Exception:
        return decoded_header(message, 'Date')


def summary(uid, raw_headers, flags):
    message = email.message_from_bytes(raw_headers, policy=default_policy)
    return {'id': uid, 'from': decoded_header(message, 'From'), 'to': decoded_header(message, 'To'),
            'subject': decoded_header(message, 'Subject'), 'date': iso_date(message), 'unread': '\\Seen' not in flags}


def search(imap, job):
    box = mailbox(imap, job.get('folder'))
    status, _ = imap.select(quoted(box), readonly=True)
    if status != 'OK':
        raise ValueError('That folder does not exist')
    query = str(job.get('query') or '').strip()
    if job.get('unread'):
        query = (query + ' is:unread').strip()
    if query:
        imap.literal = query.encode('utf-8')
        status, data = imap.uid('SEARCH', 'CHARSET', 'UTF-8', 'X-GM-RAW')
    else:
        status, data = imap.uid('SEARCH', None, 'ALL')
    if status != 'OK':
        raise ValueError('Search failed')
    uids = (data[0] or b'').split()
    limit = max(1, min(MAX_RESULTS, int(job.get('limit') or 10)))
    chosen = list(reversed(uids))[:limit]
    results = []
    for uid in chosen:
        status, parts = imap.uid('FETCH', uid, '(FLAGS BODY.PEEK[HEADER.FIELDS (FROM TO SUBJECT DATE)])')
        if status != 'OK':
            continue
        for part in parts:
            if isinstance(part, tuple):
                flags = part[0].decode('utf-8', 'replace')
                results.append(summary(uid.decode(), part[1], flags))
    return {'folder': box, 'total': len(uids), 'messages': results}


def read(imap, job):
    box = mailbox(imap, job.get('folder'))
    uid = str(job.get('id') or '')
    if not uid.isdigit():
        raise ValueError('Give a message id from a search')
    status, _ = imap.select(quoted(box), readonly=True)
    if status != 'OK':
        raise ValueError('That folder does not exist')
    status, parts = imap.uid('FETCH', uid, '(FLAGS BODY.PEEK[])')
    raw = next((part[1] for part in parts or [] if isinstance(part, tuple)), None)
    if status != 'OK' or raw is None:
        raise ValueError('That message was not found')
    message = email.message_from_bytes(raw, policy=default_policy)
    body = text_of(message)
    return {'id': uid, 'folder': box, 'from': decoded_header(message, 'From'), 'to': decoded_header(message, 'To'),
            'cc': decoded_header(message, 'Cc'), 'subject': decoded_header(message, 'Subject'), 'date': iso_date(message),
            'messageId': decoded_header(message, 'Message-ID'), 'body': body[:MAX_BODY], 'truncated': len(body) > MAX_BODY,
            'attachments': attachments_of(message)}


def main():
    job = json.loads(sys.stdin.buffer.read().decode('utf-8') or '{}')
    address, password = str(job.get('address') or ''), str(job.get('password') or '').replace(' ', '')
    if not address or not password:
        raise ValueError('No mail account is set up')
    imap = imaplib.IMAP4_SSL(HOST, 993, timeout=20)
    try:
        imap.login(address, password)
        action = job.get('action')
        if action == 'check':
            result = {'ok': True}
        elif action == 'search':
            result = search(imap, job)
        elif action == 'read':
            result = read(imap, job)
        else:
            raise ValueError('Unknown action')
    finally:
        try:
            imap.logout()
        except Exception:
            pass
    return result


if __name__ == '__main__':
    # Windows pipes default to a legacy code page; ASCII-escaped JSON is safe everywhere.
    try:
        print(json.dumps({'ok': True, 'result': main()}))
    except imaplib.IMAP4.error:
        print(json.dumps({'ok': False, 'category': 'login', 'detail': 'Gmail refused the login. Check the address and app password, and that IMAP is on.'}))
        sys.exit(1)
    except ValueError as error:
        print(json.dumps({'ok': False, 'category': 'request', 'detail': str(error)[:300]}))
        sys.exit(1)
    except Exception as error:
        print(json.dumps({'ok': False, 'category': 'network', 'detail': 'Could not reach Gmail: ' + type(error).__name__}))
        sys.exit(1)
