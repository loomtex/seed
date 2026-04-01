package main

import (
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"time"
)

// API client for the seed controller.

type Client struct {
	baseURL    string
	httpClient *http.Client
}

func NewClient(baseURL string) *Client {
	return &Client{
		baseURL: baseURL,
		httpClient: &http.Client{
			Timeout: 10 * time.Second,
		},
	}
}

// StatusResponse from GET /api/ns/:namespace/status
type StatusResponse struct {
	Namespace string                    `json:"namespace"`
	Instances map[string]InstanceStatus `json:"instances"`
	Reconcile *ReconcileStatus          `json:"reconcile"`
}

type InstanceStatus struct {
	Ready    bool   `json:"ready"`
	Phase    string `json:"phase"`
	Restarts int    `json:"restarts"`
	Age      string `json:"age"`
	Image    string `json:"image"`
}

type ReconcileStatus struct {
	Phase       string                       `json:"phase"`
	Generation  string                       `json:"generation"`
	Commit      string                       `json:"commit"`
	BuildCommit string                       `json:"buildCommit"`
	StartedAt   string                       `json:"startedAt"`
	FinishedAt  string                       `json:"finishedAt"`
	Error       string                       `json:"error"`
	Instances   map[string]InstanceBuildStatus `json:"instances"`
}

type InstanceBuildStatus struct {
	Phase string `json:"phase"`
	Error string `json:"error"`
}

// KeyIndex from GET /api/keys
type KeyIndex struct {
	Keys map[string][]NamespaceEntry `json:"keys"`
}

type NamespaceEntry struct {
	Name      string `json:"name"`
	Namespace string `json:"namespace"`
	Identity  string `json:"identity"`
}

// LogsResponse from GET /api/ns/:namespace/logs/:instance
type LogsResponse struct {
	Instance string   `json:"instance"`
	Pod      string   `json:"pod"`
	Lines    []string `json:"lines"`
	Note     string   `json:"note"`
}

// RestartResponse from POST /api/ns/:namespace/restart/:instance
type RestartResponse struct {
	Instance string `json:"instance"`
	Action   string `json:"action"`
	Pod      string `json:"pod"`
}

func (c *Client) GetStatus(namespace string) (*StatusResponse, error) {
	resp, err := c.httpClient.Get(fmt.Sprintf("%s/api/ns/%s/status", c.baseURL, namespace))
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode, body)
	}

	var result StatusResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) GetLogs(namespace, instance string, lines int) (*LogsResponse, error) {
	url := fmt.Sprintf("%s/api/ns/%s/logs/%s?lines=%d", c.baseURL, namespace, instance, lines)
	resp, err := c.httpClient.Get(url)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode, body)
	}

	var result LogsResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) Restart(namespace, instance string) (*RestartResponse, error) {
	url := fmt.Sprintf("%s/api/ns/%s/restart/%s", c.baseURL, namespace, instance)
	resp, err := c.httpClient.Post(url, "application/json", nil)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()

	if resp.StatusCode != 200 {
		body, _ := io.ReadAll(resp.Body)
		return nil, fmt.Errorf("status %d: %s", resp.StatusCode, body)
	}

	var result RestartResponse
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, err
	}
	return &result, nil
}

func (c *Client) GetKeys(namespace, instance string) (string, error) {
	url := fmt.Sprintf("%s/api/ns/%s/keys/%s", c.baseURL, namespace, instance)
	resp, err := c.httpClient.Get(url)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()

	var result struct {
		PublicKey string `json:"publicKey"`
		Error     string `json:"error"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&result); err != nil {
		return "", err
	}
	if result.Error != "" {
		return "", fmt.Errorf("%s", result.Error)
	}
	return result.PublicKey, nil
}
