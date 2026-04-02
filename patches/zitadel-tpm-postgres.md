# TPM-backed PostgreSQL client certificate authentication

Adds support for TPM 2.0-bound private keys (TSS2 PRIVATE KEY PEM format)
for PostgreSQL client certificate authentication. When `SSL.Key` points to
a TSS2 PRIVATE KEY file, Zitadel uses the TPM to perform TLS client auth
signing operations — the private key never leaves the hardware.

This enables Zitadel deployments where database credentials are
hardware-bound (e.g., confidential VMs, HSM-backed infrastructure).

## New file: `internal/database/postgres/tpm.go`

```go
package postgres

import (
	"bytes"
	"crypto/tls"
	"crypto/x509"
	"encoding/pem"
	"fmt"
	"os"

	keyfile "github.com/foxboron/go-tpm-keyfiles"
	"github.com/google/go-tpm/tpm2/transport"
	"github.com/jackc/pgx/v5/pgxpool"
)

const tpmPEMType = "TSS2 PRIVATE KEY"

// isTPMKeyFile reads a PEM file and returns true if it contains a
// TSS2 PRIVATE KEY block (TPM 2.0-bound key).
func isTPMKeyFile(path string) bool {
	data, err := os.ReadFile(path)
	if err != nil {
		return false
	}
	return bytes.Contains(data, []byte(tpmPEMType))
}

// tpmDevice is the TPM resource manager device path.
// The resource manager (/dev/tpmrm0) is preferred over the raw device
// (/dev/tpm0) because it handles context save/restore automatically,
// allowing concurrent access from multiple processes.
var tpmDevice = "/dev/tpmrm0"

// configureTPMClientCert sets up TLS client certificate authentication
// using a TPM-bound private key. It:
//  1. Strips sslcert/sslkey from the connection string (pgx can't parse TSS2 PEM)
//  2. Returns a hook that injects a TPM-backed crypto.Signer into the TLS config
//
// If the key file is not a TSS2 PEM, returns the original connection string
// and a nil hook (standard pgx TLS handling applies).
func configureTPMClientCert(connStr string, ssl SSL) (string, func(*pgxpool.Config) error, error) {
	if ssl.Key == "" || !isTPMKeyFile(ssl.Key) {
		return connStr, nil, nil
	}

	// Parse the TPM key
	keyPEM, err := os.ReadFile(ssl.Key)
	if err != nil {
		return "", nil, fmt.Errorf("read TPM key %s: %w", ssl.Key, err)
	}
	tpmKey, err := keyfile.Decode(keyPEM)
	if err != nil {
		return "", nil, fmt.Errorf("decode TPM key: %w", err)
	}

	// Parse the client certificate
	certPEM, err := os.ReadFile(ssl.Cert)
	if err != nil {
		return "", nil, fmt.Errorf("read client cert %s: %w", ssl.Cert, err)
	}
	block, _ := pem.Decode(certPEM)
	if block == nil {
		return "", nil, fmt.Errorf("no PEM block in %s", ssl.Cert)
	}
	x509Cert, err := x509.ParseCertificate(block.Bytes)
	if err != nil {
		return "", nil, fmt.Errorf("parse client cert: %w", err)
	}

	// Strip sslcert and sslkey from the connection string. pgx would
	// try to parse the TSS2 PEM as a standard private key and fail.
	// We keep sslmode and sslrootcert so pgx still sets up TLS with
	// server certificate verification.
	cleaned := stripConnStringParams(connStr, "sslcert", "sslkey")

	hook := func(poolConfig *pgxpool.Config) error {
		tlsCfg := poolConfig.ConnConfig.TLSConfig
		if tlsCfg == nil {
			return fmt.Errorf("TPM key specified but TLS not configured (check sslmode)")
		}

		// Open the TPM resource manager
		tpm, err := transport.OpenTPM(tpmDevice)
		if err != nil {
			return fmt.Errorf("open TPM device %s: %w", tpmDevice, err)
		}
		// Note: tpm is intentionally not closed here — the signer holds
		// a reference for the lifetime of the connection pool.

		signer, err := tpmKey.Signer(tpm, nil, nil)
		if err != nil {
			tpm.Close()
			return fmt.Errorf("create TPM signer: %w", err)
		}

		tlsCfg.Certificates = []tls.Certificate{{
			Certificate: [][]byte{x509Cert.Raw},
			PrivateKey:  signer,
			Leaf:        x509Cert,
		}}

		return nil
	}

	return cleaned, hook, nil
}

// stripConnStringParams removes named parameters from a libpq-style
// space-separated key=value connection string.
func stripConnStringParams(connStr string, params ...string) string {
	skip := make(map[string]bool, len(params))
	for _, p := range params {
		skip[p] = true
	}

	var result []byte
	for _, field := range bytes.Fields([]byte(connStr)) {
		idx := bytes.IndexByte(field, '=')
		if idx > 0 && skip[string(field[:idx])] {
			continue
		}
		if len(result) > 0 {
			result = append(result, ' ')
		}
		result = append(result, field...)
	}
	return string(result)
}
```

## Modified: `internal/database/postgres/pg.go`

In the `Connect()` function, add TPM detection between building the
connection string and calling `pgxpool.ParseConfig()`:

```diff
 func (c *Config) Connect(useAdmin bool, pusherRatio, spoolerRatio float64, purpose dialect.DBPurpose) (*sql.DB, error) {
-	poolConfig, err := pgxpool.ParseConfig(c.String(useAdmin))
+	connStr := c.String(useAdmin)
+
+	// Check for TPM-bound client key and configure TLS accordingly.
+	ssl := c.User.SSL
+	if useAdmin {
+		ssl = c.Admin.SSL
+	}
+	connStr, tpmHook, err := configureTPMClientCert(connStr, ssl)
+	if err != nil {
+		return nil, fmt.Errorf("TPM TLS setup: %w", err)
+	}
+
+	poolConfig, err := pgxpool.ParseConfig(connStr)
 	if err != nil {
 		return nil, err
 	}
+
+	if tpmHook != nil {
+		if err := tpmHook(poolConfig); err != nil {
+			return nil, fmt.Errorf("TPM client cert: %w", err)
+		}
+	}
```

## New dependencies in `go.mod`

```
require (
	github.com/foxboron/go-tpm-keyfiles v0.1.0
	github.com/google/go-tpm v0.9.3
)
```

## Usage

Configure the standard SSL options — the TSS2 PEM format is auto-detected:

```yaml
Database:
  postgres:
    User:
      SSL:
        Mode: verify-full
        RootCert: /path/to/ca.pem
        Cert: /path/to/cert.pem
        Key: /path/to/tpm-key.pem  # TSS2 PRIVATE KEY (auto-detected)
    Admin:
      SSL:
        Mode: verify-full
        RootCert: /path/to/ca.pem
        Cert: /path/to/cert.pem
        Key: /path/to/tpm-key.pem
```

Standard PEM private keys continue to work unchanged — TPM is only
activated when the key file contains a `TSS2 PRIVATE KEY` PEM block.
