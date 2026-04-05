package main

// Direct git plumbing against bare repos on disk.
// No network, no API — the TUI runs next to the repos.

import (
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// RepoInfo is a bare repo on disk.
type RepoInfo struct {
	Name string
	Path string
}

// Issue is the computed state of a refs/dit/ issue.
type Issue struct {
	ID      string
	Title   string
	Body    string
	Status  string
	Author  string
	Created time.Time
	Labels  []string
}

// Comment on an issue.
type Comment struct {
	Author string
	Date   string
	Body   string
}

// ScanRepos finds bare git repos under reposDir.
func ScanRepos(reposDir string) ([]RepoInfo, error) {
	entries, err := os.ReadDir(reposDir)
	if err != nil {
		return nil, err
	}
	var repos []RepoInfo
	for _, e := range entries {
		if !e.IsDir() {
			continue
		}
		name := e.Name()
		// Skip hidden dirs and non-git dirs
		if strings.HasPrefix(name, ".") {
			continue
		}
		path := filepath.Join(reposDir, name)
		// Check for bare repo marker
		if _, err := os.Stat(filepath.Join(path, "HEAD")); err != nil {
			continue
		}
		// Strip .git suffix for display
		display := strings.TrimSuffix(name, ".git")
		repos = append(repos, RepoInfo{Name: display, Path: path})
	}
	sort.Slice(repos, func(i, j int) bool { return repos[i].Name < repos[j].Name })
	return repos, nil
}

// git runs a git command in the given repo dir.
func git(repoDir string, args ...string) (string, error) {
	cmd := exec.Command("git", args...)
	cmd.Dir = repoDir
	cmd.Env = append(os.Environ(), "GIT_DIR="+repoDir)
	out, err := cmd.CombinedOutput()
	return strings.TrimSpace(string(out)), err
}

// ListIssues returns all issues in the repo.
func ListIssues(repoDir string) ([]Issue, error) {
	out, err := git(repoDir, "for-each-ref", "--format=%(refname)", "refs/dit/*/head")
	if err != nil || out == "" {
		return nil, nil
	}

	var issues []Issue
	for _, ref := range strings.Split(out, "\n") {
		ref = strings.TrimSpace(ref)
		if ref == "" {
			continue
		}
		// Extract ID from refs/dit/<id>/head
		parts := strings.Split(ref, "/")
		if len(parts) < 4 {
			continue
		}
		id := parts[2]

		head, err := git(repoDir, "rev-parse", ref)
		if err != nil {
			continue
		}

		issue, err := replayIssue(repoDir, id, head)
		if err != nil {
			continue
		}
		issues = append(issues, issue)
	}

	sort.Slice(issues, func(i, j int) bool { return issues[i].Created.After(issues[j].Created) })
	return issues, nil
}

// replayIssue computes issue state by replaying ops oldest-first.
func replayIssue(repoDir, id, head string) (Issue, error) {
	out, err := git(repoDir, "rev-list", "--first-parent", "--reverse", head)
	if err != nil {
		return Issue{}, err
	}

	issue := Issue{ID: id, Status: "open"}
	hashes := strings.Split(strings.TrimSpace(out), "\n")

	for _, hash := range hashes {
		hash = strings.TrimSpace(hash)
		if hash == "" {
			continue
		}
		msg, err := git(repoDir, "log", "-1", "--format=%B", hash)
		if err != nil {
			continue
		}
		var op map[string]interface{}
		if err := json.Unmarshal([]byte(msg), &op); err != nil {
			continue
		}

		switch op["op"] {
		case "create":
			if t, ok := op["title"].(string); ok {
				issue.Title = t
			}
			if b, ok := op["body"].(string); ok {
				issue.Body = b
			}
			if s, ok := op["status"].(string); ok {
				issue.Status = s
			}
			if labels, ok := op["labels"].([]interface{}); ok {
				for _, l := range labels {
					if ls, ok := l.(string); ok {
						issue.Labels = append(issue.Labels, ls)
					}
				}
			}
		case "set-status":
			if s, ok := op["status"].(string); ok {
				issue.Status = s
			}
		case "add-label":
			if l, ok := op["label"].(string); ok {
				issue.Labels = append(issue.Labels, l)
			}
		case "rm-label":
			if l, ok := op["label"].(string); ok {
				var filtered []string
				for _, existing := range issue.Labels {
					if existing != l {
						filtered = append(filtered, existing)
					}
				}
				issue.Labels = filtered
			}
		}
	}

	// Author and created from root commit
	if len(hashes) > 0 {
		root := strings.TrimSpace(hashes[0])
		if author, err := git(repoDir, "log", "-1", "--format=%an <%ae>", root); err == nil {
			issue.Author = author
		}
		if dateStr, err := git(repoDir, "log", "-1", "--format=%aI", root); err == nil {
			if t, err := time.Parse(time.RFC3339, dateStr); err == nil {
				issue.Created = t
			}
		}
	}

	return issue, nil
}

// IssueComments returns the comment history for an issue.
func IssueComments(repoDir, id string) ([]Comment, error) {
	head, err := git(repoDir, "rev-parse", fmt.Sprintf("refs/dit/%s/head", id))
	if err != nil {
		return nil, err
	}

	out, err := git(repoDir, "rev-list", "--first-parent", "--reverse", head)
	if err != nil {
		return nil, err
	}

	var comments []Comment
	for _, hash := range strings.Split(strings.TrimSpace(out), "\n") {
		hash = strings.TrimSpace(hash)
		if hash == "" {
			continue
		}
		msg, err := git(repoDir, "log", "-1", "--format=%B", hash)
		if err != nil {
			continue
		}
		var op map[string]interface{}
		if err := json.Unmarshal([]byte(msg), &op); err != nil {
			continue
		}

		switch op["op"] {
		case "comment":
			author, _ := git(repoDir, "log", "-1", "--format=%an", hash)
			date, _ := git(repoDir, "log", "-1", "--format=%ar", hash)
			body, _ := op["body"].(string)
			comments = append(comments, Comment{Author: author, Date: date, Body: body})
		case "set-status":
			author, _ := git(repoDir, "log", "-1", "--format=%an", hash)
			date, _ := git(repoDir, "log", "-1", "--format=%ar", hash)
			status, _ := op["status"].(string)
			comments = append(comments, Comment{
				Author: author,
				Date:   date,
				Body:   fmt.Sprintf("changed status to %s", status),
			})
		}
	}
	return comments, nil
}

// RecentCommits returns the last N commits on the default branch.
func RecentCommits(repoDir string, n int) ([]string, error) {
	head, err := git(repoDir, "rev-parse", "HEAD")
	if err != nil {
		return nil, err
	}
	out, err := git(repoDir, "log", "--oneline", fmt.Sprintf("-n%d", n), head)
	if err != nil {
		return nil, err
	}
	if out == "" {
		return nil, nil
	}
	return strings.Split(out, "\n"), nil
}
