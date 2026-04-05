package main

import (
	"fmt"
	"os"
	"sort"
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

// Status filters for issue list
var statusFilters = []string{"all", "open", "doing", "done", "closed"}

type model struct {
	reposDir string
	keyType  string
	keyBlob  string
	author   string // display name for the connected user

	repos     []RepoInfo
	issues    []Issue // all issues (unfiltered)
	filtered  []Issue // issues matching current filter

	view           int
	cursor         int
	selectedRepo   int
	selectedIssue  int
	comments       []Comment
	commentScroll  int
	width, height  int
	statusFilter   int // index into statusFilters

	// Commit activity charts (daily buckets, 6 weeks)
	allActivity  Activity // aggregate across all repos
	repoActivity Activity // selected repo only

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

type opDoneMsg struct {
	err error
}

type activityMsg struct {
	data Activity
	repo bool // true = single repo, false = aggregate
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

func cyclePriority(repoDir string, issue Issue) tea.Cmd {
	return func() tea.Msg {
		next := NextPriority(issue.Priority)
		op := map[string]interface{}{
			"op":       "set-priority",
			"priority": next,
		}
		err := PushOp(repoDir, issue.ID, op)
		return opDoneMsg{err: err}
	}
}

const activityDays = 42 // 6 weeks

func fetchAggregateActivity(repos []RepoInfo) tea.Cmd {
	return func() tea.Msg {
		agg := Activity{
			Code:   make([]int, activityDays),
			Issues: make([]int, activityDays),
		}
		for _, r := range repos {
			act := CommitActivity(r.Path, activityDays)
			for i := range agg.Code {
				if i < len(act.Code) {
					agg.Code[i] += act.Code[i]
				}
				if i < len(act.Issues) {
					agg.Issues[i] += act.Issues[i]
				}
			}
		}
		return activityMsg{data: agg, repo: false}
	}
}

func fetchRepoActivity(repoDir string) tea.Cmd {
	return func() tea.Msg {
		return activityMsg{data: CommitActivity(repoDir, activityDays), repo: true}
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
			// Preserve cursor position by repo name
			var curName string
			if m.cursor < len(m.repos) {
				curName = m.repos[m.cursor].Name
			}
			m.repos = msg.repos
			if curName != "" {
				for i, r := range m.repos {
					if r.Name == curName {
						m.cursor = i
						break
					}
				}
			}
			if m.cursor >= len(m.repos) {
				m.cursor = max(0, len(m.repos)-1)
			}
		}
		return m, fetchAggregateActivity(m.repos)

	case issuesMsg:
		if msg.err == nil {
			// Track current issue ID to restore cursor after refresh
			var curID string
			if m.cursor < len(m.filtered) {
				curID = m.filtered[m.cursor].ID
			}
			m.issues = msg.issues
			m.applyFilter()
			// Restore cursor by ID, or clamp to bounds
			if curID != "" {
				m.cursor = 0
				for i, issue := range m.filtered {
					if issue.ID == curID {
						m.cursor = i
						break
					}
				}
			}
			if m.cursor >= len(m.filtered) {
				m.cursor = max(0, len(m.filtered)-1)
			}
		}
		return m, nil

	case commentsMsg:
		if msg.err == nil {
			m.comments = msg.comments
		}
		m.commentScroll = 0
		return m, nil

	case activityMsg:
		if msg.repo {
			m.repoActivity = msg.data
		} else {
			m.allActivity = msg.data
		}
		return m, nil

	case opDoneMsg:
		if msg.err != nil {
			m.statusMsg = fmt.Sprintf("error: %v", msg.err)
			m.statusExpiry = time.Now().Add(5 * time.Second)
			return m, nil
		}
		// Refresh issues after a write op
		if m.selectedRepo < len(m.repos) {
			return m, fetchIssues(m.repos[m.selectedRepo].Path)
		}
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

// statusPriority orders issues: active statuses first, closed last.
func statusPriority(s string) int {
	switch s {
	case "doing":
		return 0
	case "open":
		return 1
	case "done":
		return 2
	case "closed":
		return 3
	default:
		return 1
	}
}

// issuePriority maps priority string to sort rank (lower = higher priority).
func issuePriority(p string) int {
	switch p {
	case "high":
		return 0
	case "normal", "":
		return 1
	case "low":
		return 2
	default:
		return 1
	}
}

// priorityIndicator returns the display string for a priority level.
func priorityIndicator(p string) string {
	switch p {
	case "high":
		return lipgloss.NewStyle().Foreground(gruvYellow).Render("▲")
	case "low":
		return dimStyle.Render("▼")
	default:
		return " "
	}
}

func (m *model) applyFilter() {
	filter := statusFilters[m.statusFilter]
	cutoff := time.Now().Add(-7 * 24 * time.Hour)
	m.filtered = nil
	for _, issue := range m.issues {
		// Hide done/closed issues older than 7 days (unless explicitly filtered to that status)
		if filter != issue.Status && (issue.Status == "done" || issue.Status == "closed") {
			if !issue.StatusChanged.IsZero() && issue.StatusChanged.Before(cutoff) {
				continue
			}
		}
		if filter != "all" && issue.Status != filter {
			continue
		}
		m.filtered = append(m.filtered, issue)
	}
	// Sort: status priority, then issue priority, then newest first
	sort.SliceStable(m.filtered, func(i, j int) bool {
		si, sj := statusPriority(m.filtered[i].Status), statusPriority(m.filtered[j].Status)
		if si != sj {
			return si < sj
		}
		pi, pj := issuePriority(m.filtered[i].Priority), issuePriority(m.filtered[j].Priority)
		if pi != pj {
			return pi < pj
		}
		return m.filtered[i].Created.After(m.filtered[j].Created)
	})
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
			m.repoActivity = Activity{}
			return m, tea.Batch(
				fetchIssues(m.repos[m.selectedRepo].Path),
				fetchRepoActivity(m.repos[m.selectedRepo].Path),
			)
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
		if m.cursor < len(m.filtered)-1 {
			m.cursor++
		}
	case "enter", "l":
		if m.cursor < len(m.filtered) {
			m.selectedIssue = m.cursor
			m.view = viewIssueDetail
			m.commentScroll = 0
			issue := m.filtered[m.selectedIssue]
			return m, fetchComments(m.repos[m.selectedRepo].Path, issue.ID)
		}
	case "p":
		if m.cursor < len(m.filtered) && m.selectedRepo < len(m.repos) {
			return m, cyclePriority(m.repos[m.selectedRepo].Path, m.filtered[m.cursor])
		}
	case "f":
		m.statusFilter = (m.statusFilter + 1) % len(statusFilters)
		m.applyFilter()
		m.cursor = 0
	case "F":
		m.statusFilter = (m.statusFilter + len(statusFilters) - 1) % len(statusFilters)
		m.applyFilter()
		m.cursor = 0
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
		issue := m.filtered[m.selectedIssue]
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
	chartStyle   = lipgloss.NewStyle().Foreground(gruvAqua)
	chartLabel   = lipgloss.NewStyle().Foreground(gruvGray)
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

func (m model) renderStatus() string {
	if m.statusMsg != "" && time.Now().Before(m.statusExpiry) {
		return "  " + lipgloss.NewStyle().Foreground(gruvRed).Render(m.statusMsg)
	}
	return ""
}

var chartIssueStyle = lipgloss.NewStyle().Foreground(lipgloss.Color("#fe8019")) // gruvbox orange

// renderChart draws a stacked braille area chart. Code commits in aqua,
// issue (dit) commits stacked on top in orange.
func renderChart(act Activity, width, availHeight int) string {
	if len(act.Code) == 0 || width < 4 || availHeight < 2 {
		return ""
	}

	total := 0
	peak := 0
	for i := range act.Code {
		total += act.Code[i]
		d := act.Code[i]
		if i < len(act.Issues) {
			d += act.Issues[i]
		}
		if d > peak {
			peak = d
		}
	}

	chartHeight := availHeight - 1
	if chartHeight < 1 {
		chartHeight = 1
	}
	if chartHeight > 6 {
		chartHeight = 6
	}

	chartWidth := width - 2
	if chartWidth < 4 {
		chartWidth = 4
	}

	var b strings.Builder
	b.WriteString(chartLabel.Render(fmt.Sprintf("  %d commits · 6 weeks · peak %d/day", total, peak)) + "\n")

	lines := StackedAreaChart(act.Code, act.Issues, chartWidth, chartHeight)
	for _, line := range lines {
		// Color each character: orange where overlay has dots, aqua otherwise.
		// Full = base|overlay combined, so we just pick color per character.
		var row strings.Builder
		row.WriteString("  ")
		fullRunes := []rune(line.Full)
		overRunes := []rune(line.Overlay)
		for i, ch := range fullRunes {
			if i < len(overRunes) && overRunes[i] != '\u2800' {
				row.WriteString(chartIssueStyle.Render(string(ch)))
			} else {
				row.WriteString(chartStyle.Render(string(ch)))
			}
		}
		b.WriteString(row.String() + "\n")
	}
	return b.String()
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

	listLines := strings.Count(b.String(), "\n")

	// Chart fills space between list and help bar
	chartAvail := m.height - listLines - 2 // 2 = help bar + padding
	if chartAvail > 2 && len(m.allActivity.Code) > 0 {
		b.WriteString("\n")
		b.WriteString(renderChart(m.allActivity, m.width, chartAvail-1))
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
	// Filter indicator
	filterLabel := statusFilters[m.statusFilter]
	b.WriteString(headerStyle.Render("silo") + "  " + titleStyle.Render(repoName) + "  " + dimStyle.Render("issues") + "  " + statusStyle(filterLabel).Render(filterLabel) + "\n\n")

	if len(m.filtered) == 0 {
		b.WriteString(dimStyle.Render("  no issues") + "\n")
	}

	for i, issue := range m.filtered {
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

		b.WriteString(fmt.Sprintf("%s%s %s %s  %s%s\n",
			prefix,
			dimStyle.Render(shortID),
			priorityIndicator(issue.Priority),
			st.Render(issue.Status),
			issue.Title,
			labels,
		))
	}

	listLines := strings.Count(b.String(), "\n")

	// Chart fills space between issue list and help bar
	chartAvail := m.height - listLines - 2
	if chartAvail > 2 && len(m.repoActivity.Code) > 0 {
		b.WriteString("\n")
		b.WriteString(renderChart(m.repoActivity, m.width, chartAvail-1))
	}

	lines := strings.Count(b.String(), "\n")
	for i := lines; i < m.height-2; i++ {
		b.WriteString("\n")
	}
	if s := m.renderStatus(); s != "" {
		b.WriteString(s + "\n")
	}
	b.WriteString(helpStyle.Render("j/k nav  enter detail  p priority  f filter  esc back  R refresh  q quit"))

	return b.String()
}

func (m model) viewDetail() string {
	var b strings.Builder

	if m.selectedIssue >= len(m.filtered) {
		return "no issue selected"
	}
	issue := m.filtered[m.selectedIssue]

	shortID := issue.ID
	if len(shortID) > 8 {
		shortID = shortID[:8]
	}

	st := statusStyle(issue.Status)

	b.WriteString(headerStyle.Render("silo") + "  " + titleStyle.Render(issue.Title) + "\n\n")
	b.WriteString(fmt.Sprintf("  id:       %s\n", dimStyle.Render(shortID)))
	b.WriteString(fmt.Sprintf("  status:   %s\n", st.Render(issue.Status)))
	if issue.Priority != "normal" && issue.Priority != "" {
		b.WriteString(fmt.Sprintf("  priority: %s %s\n", priorityIndicator(issue.Priority), issue.Priority))
	}
	b.WriteString(fmt.Sprintf("  author:   %s\n", dimStyle.Render(issue.Author)))
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
