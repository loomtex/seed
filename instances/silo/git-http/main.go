// silo-auth-verify — Ed25519 signature verification for nginx auth_request.
//
// nginx sends the original request headers via auth_request subrequest.
// This service verifies the Authorization header and returns:
//   200 + X-Silo-Key-Blob header  → authenticated, nginx passes identity to git
//   401                            → rejected
//
// Auth protocol:
//   Authorization: SiloKey <base64-pubkey> <base64-signature> <unix-timestamp>
//   Signature covers: "silo-auth:<timestamp>"
//
// Stateless. No dependencies beyond the request headers.
package main

import (
	"crypto/ed25519"
	"encoding/base64"
	"fmt"
	"log"
	"math"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/crypto/ssh"
)

var (
	listenAddr   = envOr("SILO_AUTH_LISTEN", "127.0.0.1:9419")
	maxClockSkew = 5 * time.Minute
)

func envOr(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

func main() {
	http.HandleFunc("/", verify)
	log.Printf("silo-auth-verify listening on %s", listenAddr)
	if err := http.ListenAndServe(listenAddr, nil); err != nil {
		log.Fatal(err)
	}
}

func verify(w http.ResponseWriter, r *http.Request) {
	auth := r.Header.Get("Authorization")
	if auth == "" {
		http.Error(w, "no auth", http.StatusUnauthorized)
		return
	}

	if !strings.HasPrefix(auth, "SiloKey ") {
		http.Error(w, "unsupported scheme", http.StatusUnauthorized)
		return
	}

	parts := strings.Fields(auth[len("SiloKey "):])
	if len(parts) != 3 {
		http.Error(w, "malformed header", http.StatusUnauthorized)
		return
	}

	pubKeyB64, sigB64, tsStr := parts[0], parts[1], parts[2]

	// Replay protection — reject timestamps older than maxClockSkew
	ts, err := strconv.ParseInt(tsStr, 10, 64)
	if err != nil {
		http.Error(w, "bad timestamp", http.StatusUnauthorized)
		return
	}
	skew := math.Abs(time.Since(time.Unix(ts, 0)).Seconds())
	if skew > maxClockSkew.Seconds() {
		http.Error(w, "timestamp expired", http.StatusUnauthorized)
		return
	}

	// Decode and parse public key (wire format, not authorized_keys format)
	pubKeyBytes, err := base64.StdEncoding.DecodeString(pubKeyB64)
	if err != nil {
		http.Error(w, "bad key encoding", http.StatusUnauthorized)
		return
	}

	pubKey, err := ssh.ParsePublicKey(pubKeyBytes)
	if err != nil {
		http.Error(w, "bad key", http.StatusUnauthorized)
		return
	}

	// Verify signature over "silo-auth:<timestamp>"
	message := fmt.Sprintf("silo-auth:%s", tsStr)
	sigBytes, err := base64.StdEncoding.DecodeString(sigB64)
	if err != nil {
		http.Error(w, "bad signature encoding", http.StatusUnauthorized)
		return
	}

	edKey, ok := pubKey.(ssh.CryptoPublicKey).CryptoPublicKey().(ed25519.PublicKey)
	if !ok {
		http.Error(w, "only ed25519 supported", http.StatusUnauthorized)
		return
	}

	if !ed25519.Verify(edKey, []byte(message), sigBytes) {
		http.Error(w, "bad signature", http.StatusUnauthorized)
		return
	}

	// Return the key blob so nginx can pass it to git-http-backend.
	// The pre-receive hook matches this against .owner_key / .authorized_keys.
	w.Header().Set("X-Silo-Key-Blob", pubKeyB64)
	w.WriteHeader(http.StatusOK)
}
