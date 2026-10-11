"""PKI effimera esclusivamente per il server TLS localhost dei test."""
from cryptography import x509
from cryptography.x509.oid import NameOID, ExtendedKeyUsageOID
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from datetime import datetime, timedelta, timezone
from pathlib import Path
import sys,ipaddress
out=Path(sys.argv[1]);now=datetime.now(timezone.utc)
def key():return rsa.generate_private_key(public_exponent=65537,key_size=2048)
ca_key=key();ca_name=x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'OFFICINA TEST ONLY CA')])
ca=x509.CertificateBuilder().subject_name(ca_name).issuer_name(ca_name).public_key(ca_key.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(days=1)).add_extension(x509.BasicConstraints(ca=True,path_length=0),critical=True).sign(ca_key,hashes.SHA256())
(out/'ca.pem').write_bytes(ca.public_bytes(serialization.Encoding.PEM))
for name,usage in [('server',ExtendedKeyUsageOID.SERVER_AUTH),('client',ExtendedKeyUsageOID.CLIENT_AUTH)]:
    k=key();b=x509.CertificateBuilder().subject_name(x509.Name([x509.NameAttribute(NameOID.COMMON_NAME,'localhost')])).issuer_name(ca_name).public_key(k.public_key()).serial_number(x509.random_serial_number()).not_valid_before(now-timedelta(minutes=1)).not_valid_after(now+timedelta(days=1)).add_extension(x509.BasicConstraints(ca=False,path_length=None),critical=True).add_extension(x509.ExtendedKeyUsage([usage]),critical=False)
    if name=='server':b=b.add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'),x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]),critical=False)
    cert=b.sign(ca_key,hashes.SHA256())
    (out/(name+'.pem')).write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    (out/(name+'.key')).write_bytes(k.private_bytes(serialization.Encoding.PEM,serialization.PrivateFormat.PKCS8,serialization.NoEncryption()))
