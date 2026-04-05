package main

import (
	"fmt"
	"os"
	"strings"
	"time"

	tea "github.com/charmbracelet/bubbletea"
	"github.com/charmbracelet/lipgloss"
)

// Views
const (
	viewRepos = iota
	viewIssues
	viewIssueDetail
)

type model struct {
	reposDir string
	keyType  string
	keyBlob  string
	author   string // display name for the connected user

	repos  []RepoInfo
	issues []Issue

	view           int
	cursor         int
	selectedRepo   int
	selectedIssue  int
	comments       []Comment
	commentScroll  int
	width, height  int

	statusMsg    string
	statusExpiry time.Time
}

// Messages
type reposMsg struct {
	repos []RepoInfo
	err   error
}

type issuesMsg struct {
	issues []Issue
	err    error
}

type commentsMsg struct {
	comments []Comment
	err      error
}

type tickMsg time.Time

func tickCmd() tea.Cmd {
	return tea.Tick(10*time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func fetchRepos(reposDir string) tea.Cmd {
	return func() tea.Msg {
		repos, err := ScanRepos(reposDir)
		return reposMsg{repos: repos, err: err}
	}
}

func fetchIssues(repoDir string) tea.Cmd {
	return func() tea.Msg {
		issues, err := ListIssues(repoDir)
		return issuesMsg{issues: issues, err: err}
	}
}

func fetchComments(repoDir, id string) tea.Cmd {
	return func() tea.Msg {
		comments, err := IssueComments(repoDir, id)
		return commentsMsg{comments: comments, err: err}
	}
}

func initialModel(reposDir, keyType, keyBlob string) model {
	return model{
		reposDir: reposDir,
		keyType:  keyType,
		keyBlob:  keyBlob,
		view:     viewRepos,
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(fetchRepos(m.reposDir), tickCmd())
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		return m.handleKey(msg)

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case reposMsg:
		if msg.err == nil {
			m.repos = msg.repos
		}
		return m, nil

	case issuesMsg:
		if msg.err == nil {
			m.issues = msg.issues
		}
		m.cursor = 0
		return m, nil

	case commentsMsg:
		if msg.err == nil {
			m.comments = msg.comments
		}
		m.commentScroll = 0
		return m, nil

	case tickMsg:
		switch m.view {
		case viewRepos:
			return m, tea.Batch(fetchRepos(m.reposDir), tickCmd())
		case viewIssues:
			if m.selectedRepo < len(m.repos) {
				return m, tea.Batch(fetchIssues(m.repos[m.selectedRepo].Path), tickCmd())
			}
		}
		return m, tickCmd()
	}
	return m, nil
}

func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch m.view {
	case viewRepos:
		return m.handleReposKey(msg)
	case viewIssues:
		return m.handleIssuesKey(msg)
	case viewIssueDetail:
		return m.handleDetailKey(msg)
	}
	return m, nil
}

func (m model) handleReposKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.repos)-1 {
			m.cursor++
		}
	case "enter", "l":
		if m.cursor < len(m.repos) {
			m.selectedRepo = m.cursor
			m.view = viewIssues
			m.cursor = 0
			return m, fetchIssues(m.repos[m.selectedRepo].Path)
		}
	case "R":
		return m, fetchRepos(m.reposDir)
	}
	return m, nil
}

func (m model) handleIssuesKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "esc", "h":
		m.view = viewRepos
		m.cursor = m.selectedRepo
		return m, nil
	case "up", "k":
		if m.cursor > 0 {
			m.cursor--
		}
	case "down", "j":
		if m.cursor < len(m.issues)-1 {
			m.cursor++
		}
	case "enter", "l":
		if m.cursor < len(m.issues) {
			m.selectedIssue = m.cursor
			m.view = viewIssueDetail
			m.commentScroll = 0
			issue := m.issues[m.selectedIssue]
			return m, fetchComments(m.repos[m.selectedRepo].Path, issue.ID)
		}
	case "R":
		if m.selectedRepo < len(m.repos) {
			return m, fetchIssues(m.repos[m.selectedRepo].Path)
		}
	}
	return m, nil
}

func (m model) handleDetailKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit
	case "esc", "h":
		m.view = viewIssues
		m.cursor = m.selectedIssue
		return m, nil
	case "up", "k":
		if m.commentScroll > 0 {
			m.commentScroll--
		}
	case "down", "j":
		maxScroll := max(0, len(m.comments)-(m.height-10))
		if m.commentScroll < maxScroll {
			m.commentScroll++
		}
	case "R":
		issue := m.issues[m.selectedIssue]
		return m, fetchComments(m.repos[m.selectedRepo].Path, issue.ID)
	}
	return m, nil
}

// --- Styles (gruvbox dark hard, matching seed TUI) ---

var (
	gruvBg     = lipgloss.Color("#1d2021")
	gruvFg     = lipgloss.Color("#ebdbb2")
	gruvRed    = lipgloss.Color("#fb4934")
	gruvGreen  = lipgloss.Color("#b8bb26")
	gruvYellow = lipgloss.Color("#fabd2f")
	gruvBlue   = lipgloss.Color("#83a598")
	gruvPurple = lipgloss.Color("#d3869b")
	gruvAqua   = lipgloss.Color("#8ec07c")
	gruvGray   = lipgloss.Color("#928374")

	titleStyle  = lipgloss.NewStyle().Bold(true).Underline(true).Foreground(gruvFg)
	dimStyle    = lipgloss.NewStyle().Foreground(gruvGray)
	cursorStyle = lipgloss.NewStyle().Bold(true).Foreground(gruvAqua)
	helpStyle   = lipgloss.NewStyle().Foreground(gruvGray)
	headerStyle = lipgloss.NewStyle().Bold(true).Foreground(gruvPurple)

	statusOpen   = lipgloss.NewStyle().Foreground(gruvGreen)
	statusDoing  = lipgloss.NewStyle().Foreground(gruvBlue)
	statusDone   = lipgloss.NewStyle().Foreground(gruvGray)
	statusClosed = lipgloss.NewStyle().Foreground(gruvRed)
)

func statusStyle(s string) lipgloss.Style {
	switch s {
	case "open":
		return statusOpen
	case "doing":
		return statusDoing
	case "done":
		return statusDone
	case "closed":
		return statusClosed
	default:
		return dimStyle
	}
}

func (m model) View() string {
	switch m.view {
	case viewIssues:
		return m.viewIssues()
	case viewIssueDetail:
		return m.viewDetail()
	default:
		return m.viewRepos()
	}
}

func (m model) viewRepos() string {
	var b strings.Builder

	b.WriteString(headerStyle.Render("silo"))
	id := m.keyBlob
	if len(id) > 16 {
		id = id[:16] + "…"
	}
	if id != "" {
		b.WriteString("  " + dimStyle.Render(id))
	}
	b.WriteString("\n\n")

	if len(m.repos) == 0 {
		b.WriteString(dimStyle.Render("  no repositories") + "\n")
	}

	for i, r := range m.repos {
		prefix := "  "
		if i == m.cursor {
			prefix = cursorStyle.Render("▸ ")
		}
		b.WriteString(prefix + titleStyle.Render(r.Name) + "\n")
	}

	lines := strings.Count(b.String(), "\n")
	for i := lines; i < m.height-2; i++ {
		b.WriteString("\n")
	}
	b.WriteString(helpStyle.Render("j/k nav  enter issues  R refresh  q quit"))

	return b.String()
}

func (m model) viewIssues() string {
	var b strings.Builder

	repoName := ""
	if m.selectedRepo < len(m.repos) {
		repoName = m.repos[m.selectedRepo].Name
	}
	b.WriteString(headerStyle.Render("silo") + "  " + titleStyle.Render(repoName) + "  " + dimStyle.Render("issues") + "\n\n")

	if len(m.issues) == 0 {
		b.WriteString(dimStyle.Render("  no issues") + "\n")
	}

	for i, issue := range m.issues {
		prefix := "  "
		if i == m.cursor {
			prefix = cursorStyle.Render("▸ ")
		}

		st := statusStyle(issue.Status)
		shortID := issue.ID
		if len(shortID) > 8 {
			shortID = shortID[:8]
		}

		labels := ""
		if len(issue.Labels) > 0 {
			labels = " " + dimStyle.Render("["+strings.Join(issue.Labels, ", ")+"]")
		}

		b.WriteString(fmt.Sprintf("%s%s %s  %s%s\n",
			prefix,
			dimStyle.Render(shortID),
			st.Render(issue.Status),
			issue.Title,
			labels,
		))
	}

	lines := strings.Count(b.String(), "\n")
	for i := lines; i < m.height-2; i++ {
		b.WriteString("\n")
	}
	b.WriteString(helpStyle.Render("j/k nav  enter detail  esc back  R refresh  q quit"))

	return b.String()
}

func (m model) viewDetail() string {
	var b strings.Builder

	if m.selectedIssue >= len(m.issues) {
		return "no issue selected"
	}
	issue := m.issues[m.selectedIssue]

	shortID := issue.ID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}

	st := statusStyle(issue.Status)

	b.WriteString(headerStyle.Render("silo") + "  " + titleStyle.Render(issue.Title) + "\n\n")
	b.WriteString(fmt.Sprintf("  id:      %s\n", dimStyle.Render(shortID)))
	b.WriteString(fmt.Sprintf("  status:  %s\n", st.Render(issue.Status)))
	b.WriteString(fmt.Sprintf("  author:  %s\n", dimStyle.Render(issue.Author)))
	if !issue.Created.IsZero() {
		b.WriteString(fmt.Sprintf("  created: %s\n", dimStyle.Render(issue.Created.Format("2006-01-02 15:04"))))
	}
	if len(issue.Labels) > 0 {
		b.WriteString(fmt.Sprintf("  labels:  %s\n", dimStyle.Render(strings.Join(issue.Labels, ", "))))
	}

	if issue.Body != "" {
		b.WriteString("\n  " + issue.Body + "\n")
	}

	b.WriteString("\n" + dimStyle.Render("  "+strings.Repeat("─", min(m.width-4, 76))) + "\n")

	// Comments
	viewHeight := m.height - strings.Count(b.String(), "\n") - 2
	end := min(m.commentScroll+viewHeight, len(m.comments))
	for i := m.commentScroll; i < end; i++ {
		c := m.comments[i]
		b.WriteString(fmt.Sprintf("\n  %s %s\n", dimStyle.Render(c.Author), dimStyle.Render("("+c.Date+")")))
		b.WriteString("  " + c.Body + "\n")
	}

	lines := strings.Count(b.String(), "\n")
	for i := lines; i < m.height-2; i++ {
		b.WriteString("\n")
	}
	b.WriteString(helpStyle.Render("j/k scroll  esc back  R refresh  q quit"))

	return b.String()
}

func main() {
	reposDir := os.Getenv("SILO_REPOS_DIR")
	if reposDir == "" {
		fmt.Fprintf(os.Stderr, "SILO_REPOS_DIR not set\n")
		os.Exit(1)
	}

	keyType := os.Getenv("SILO_KEY_TYPE")
	keyBlob := os.Getenv("SILO_KEY_BLOB")

	p := tea.NewProgram(
		initialModel(reposDir, keyType, keyBlob),
		tea.WithAltScreen(),
	)
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
