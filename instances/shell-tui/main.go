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
	viewDashboard = iota
	viewLogs
)

// Repo is a flake with its namespace, identity, and live status.
type Repo struct {
	Name      string
	Namespace string
	Identity  string
	Status    *StatusResponse
	Error     error
}

type model struct {
	client *Client
	repos  []Repo
	cursor int
	// Instance cursor within expanded repo
	instanceCursor int
	expanded       int // index of expanded repo, -1 if none
	view           int
	width, height  int

	// Logs view
	logLines     []string
	logInstance  string
	logRepo      string
	logScroll    int

	// Status line message
	statusMsg    string
	statusExpiry time.Time

	// Tick for auto-refresh
	lastRefresh time.Time
}

// Messages

type statusMsg struct {
	index int
	resp  *StatusResponse
	err   error
}

type logsMsg struct {
	lines []string
	err   error
}

type restartMsg struct {
	instance string
	err      error
}

type tickMsg time.Time

func tickCmd() tea.Cmd {
	return tea.Tick(5*time.Second, func(t time.Time) tea.Msg {
		return tickMsg(t)
	})
}

func (m model) fetchStatus(index int) tea.Cmd {
	return func() tea.Msg {
		resp, err := m.client.GetStatus(m.repos[index].Namespace)
		return statusMsg{index: index, resp: resp, err: err}
	}
}

func (m model) fetchAllStatus() tea.Cmd {
	var cmds []tea.Cmd
	for i := range m.repos {
		i := i
		cmds = append(cmds, m.fetchStatus(i))
	}
	return tea.Batch(cmds...)
}

func (m model) fetchLogs(namespace, instance string) tea.Cmd {
	return func() tea.Msg {
		resp, err := m.client.GetLogs(namespace, instance, 200)
		if err != nil {
			return logsMsg{err: err}
		}
		return logsMsg{lines: resp.Lines}
	}
}

func (m model) restartInstance(namespace, instance string) tea.Cmd {
	return func() tea.Msg {
		_, err := m.client.Restart(namespace, instance)
		return restartMsg{instance: instance, err: err}
	}
}

func initialModel(client *Client, repos []Repo) model {
	return model{
		client:         client,
		repos:          repos,
		cursor:         0,
		instanceCursor: 0,
		expanded:       -1,
		view:           viewDashboard,
		lastRefresh:    time.Now(),
	}
}

func (m model) Init() tea.Cmd {
	return tea.Batch(m.fetchAllStatus(), tickCmd())
}

func (m model) Update(msg tea.Msg) (tea.Model, tea.Cmd) {
	switch msg := msg.(type) {
	case tea.KeyMsg:
		return m.handleKey(msg)

	case tea.WindowSizeMsg:
		m.width = msg.Width
		m.height = msg.Height
		return m, nil

	case statusMsg:
		if msg.index < len(m.repos) {
			m.repos[msg.index].Status = msg.resp
			m.repos[msg.index].Error = msg.err
		}
		return m, nil

	case logsMsg:
		if msg.err != nil {
			m.logLines = []string{fmt.Sprintf("error: %v", msg.err)}
		} else {
			m.logLines = msg.lines
		}
		// Scroll to bottom
		m.logScroll = max(0, len(m.logLines)-(m.height-4))
		return m, nil

	case restartMsg:
		if msg.err != nil {
			m.statusMsg = fmt.Sprintf("restart failed: %v", msg.err)
		} else {
			m.statusMsg = fmt.Sprintf("restarted %s", msg.instance)
		}
		m.statusExpiry = time.Now().Add(5 * time.Second)
		return m, m.fetchAllStatus()

	case tickMsg:
		m.lastRefresh = time.Now()
		return m, tea.Batch(m.fetchAllStatus(), tickCmd())
	}

	return m, nil
}

func (m model) handleKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch m.view {
	case viewDashboard:
		return m.handleDashboardKey(msg)
	case viewLogs:
		return m.handleLogsKey(msg)
	}
	return m, nil
}

func (m model) handleDashboardKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "ctrl+c":
		return m, tea.Quit

	case "up", "k":
		if m.expanded >= 0 {
			if m.instanceCursor > 0 {
				m.instanceCursor--
			} else {
				// Collapse and move up
				m.expanded = -1
				if m.cursor > 0 {
					m.cursor--
				}
			}
		} else if m.cursor > 0 {
			m.cursor--
		}

	case "down", "j":
		if m.expanded >= 0 {
			instances := m.sortedInstances(m.expanded)
			if m.instanceCursor < len(instances)-1 {
				m.instanceCursor++
			} else {
				// Collapse and move down
				m.expanded = -1
				if m.cursor < len(m.repos)-1 {
					m.cursor++
				}
			}
		} else if m.cursor < len(m.repos)-1 {
			m.cursor++
		}

	case "enter", "right", "l":
		if m.expanded == -1 {
			m.expanded = m.cursor
			m.instanceCursor = 0
		} else {
			// Open logs for selected instance
			instances := m.sortedInstances(m.expanded)
			if m.instanceCursor < len(instances) {
				inst := instances[m.instanceCursor]
				ns := m.repos[m.expanded].Namespace
				m.view = viewLogs
				m.logInstance = inst
				m.logRepo = m.repos[m.expanded].Name
				m.logLines = []string{"loading..."}
				m.logScroll = 0
				return m, m.fetchLogs(ns, inst)
			}
		}

	case "left", "h", "esc":
		if m.expanded >= 0 {
			m.expanded = -1
		}

	case "r":
		if m.expanded >= 0 {
			instances := m.sortedInstances(m.expanded)
			if m.instanceCursor < len(instances) {
				inst := instances[m.instanceCursor]
				ns := m.repos[m.expanded].Namespace
				m.statusMsg = fmt.Sprintf("restarting %s...", inst)
				m.statusExpiry = time.Now().Add(10 * time.Second)
				return m, m.restartInstance(ns, inst)
			}
		}

	case "R":
		return m, m.fetchAllStatus()
	}

	return m, nil
}

func (m model) handleLogsKey(msg tea.KeyMsg) (tea.Model, tea.Cmd) {
	switch msg.String() {
	case "q", "esc", "left", "h":
		m.view = viewDashboard
		return m, nil

	case "up", "k":
		if m.logScroll > 0 {
			m.logScroll--
		}

	case "down", "j":
		maxScroll := max(0, len(m.logLines)-(m.height-4))
		if m.logScroll < maxScroll {
			m.logScroll++
		}

	case "pgup", "ctrl+b":
		page := m.height - 4
		m.logScroll = max(0, m.logScroll-page)

	case "pgdown", "ctrl+f":
		page := m.height - 4
		maxScroll := max(0, len(m.logLines)-page)
		m.logScroll = min(maxScroll, m.logScroll+page)

	case "g":
		m.logScroll = 0

	case "G":
		m.logScroll = max(0, len(m.logLines)-(m.height-4))

	case "R":
		ns := m.repos[m.expanded].Namespace
		return m, m.fetchLogs(ns, m.logInstance)

	case "ctrl+c":
		return m, tea.Quit
	}
	return m, nil
}

func (m model) sortedInstances(repoIdx int) []string {
	r := m.repos[repoIdx]
	if r.Status == nil {
		return nil
	}
	names := make([]string, 0, len(r.Status.Instances))
	for name := range r.Status.Instances {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// --- Styles ---

// Gruvbox dark hard palette
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
	gruvOrange = lipgloss.Color("#fe8019")

	titleStyle    = lipgloss.NewStyle().Bold(true).Underline(true).Foreground(gruvFg)
	dimStyle      = lipgloss.NewStyle().Foreground(gruvGray)
	readyStyle    = lipgloss.NewStyle().Foreground(gruvGreen)
	notReadyStyle = lipgloss.NewStyle().Foreground(gruvRed)
	cursorStyle   = lipgloss.NewStyle().Bold(true).Foreground(gruvAqua)
	warnStyle     = lipgloss.NewStyle().Foreground(gruvYellow)
	errorStyle    = lipgloss.NewStyle().Foreground(gruvRed)
	headerStyle   = lipgloss.NewStyle().Bold(true).Foreground(gruvPurple)
	helpStyle     = lipgloss.NewStyle().Foreground(gruvGray)
)

func (m model) View() string {
	switch m.view {
	case viewLogs:
		return m.viewLogs()
	default:
		return m.viewDashboard()
	}
}

func (m model) viewDashboard() string {
	var b strings.Builder

	// Header
	b.WriteString(headerStyle.Render("seed"))
	b.WriteString(dimStyle.Render(fmt.Sprintf("  %s", time.Now().Format("15:04:05"))))
	b.WriteString("\n\n")

	for i, r := range m.repos {
		isCurrent := i == m.cursor && m.expanded == -1

		// Repo header
		prefix := "  "
		if isCurrent {
			prefix = cursorStyle.Render("▸ ")
		} else if m.expanded == i {
			prefix = cursorStyle.Render("▾ ")
		}

		line := prefix + titleStyle.Render(r.Name)
		if r.Status != nil && r.Status.Reconcile != nil && r.Status.Reconcile.Commit != "" {
			line += " " + dimStyle.Render("("+r.Status.Reconcile.Commit+")")
		}
		line += "  " + dimStyle.Render(r.Namespace)
		if r.Identity != "" {
			line += "  " + dimStyle.Render(r.Identity[:min(16, len(r.Identity))]+"…")
		}
		b.WriteString(line + "\n")

		if r.Error != nil {
			b.WriteString("    " + errorStyle.Render(fmt.Sprintf("error: %v", r.Error)) + "\n")
		}

		if r.Status == nil {
			continue
		}

		// Instances (always show, highlight if expanded)
		instances := m.sortedInstances(i)
		for j, name := range instances {
			inst := r.Status.Instances[name]

			instPrefix := "    "
			if m.expanded == i && j == m.instanceCursor {
				instPrefix = cursorStyle.Render("  ▸ ")
			} else {
				instPrefix = "    "
			}

			var dot, status string
			if inst.Ready {
				dot = readyStyle.Render("●")
				status = readyStyle.Render("ready")
			} else {
				dot = notReadyStyle.Render("●")
				status = notReadyStyle.Render("not ready")
			}

			info := fmt.Sprintf("phase=%s  restarts=%d  age=%s",
				inst.Phase, inst.Restarts, inst.Age)

			b.WriteString(fmt.Sprintf("%s%-12s %s %s  %s\n",
				instPrefix, name, dot, status, dimStyle.Render(info)))
		}

		// Build status
		if rc := r.Status.Reconcile; rc != nil {
			switch rc.Phase {
			case "failed":
				commit := rc.BuildCommit
				if commit == "" {
					commit = "?"
				}
				b.WriteString("    " + errorStyle.Render(fmt.Sprintf("build %s failed: %s", commit, rc.Error)) + "\n")
			case "evaluating", "building", "applying":
				msg := "⧗ " + rc.Phase
				if rc.BuildCommit != "" {
					msg += " " + rc.BuildCommit
				}
				// List instances being built
				var building []string
				for iname, is := range rc.Instances {
					if is.Phase == "building" {
						building = append(building, iname)
					}
				}
				sort.Strings(building)
				if len(building) > 0 {
					msg += " — building: " + strings.Join(building, ", ")
				}
				b.WriteString("    " + warnStyle.Render(msg) + "\n")
			}
		}

		b.WriteString("\n")
	}

	// Status message
	if m.statusMsg != "" && time.Now().Before(m.statusExpiry) {
		b.WriteString("\n" + warnStyle.Render(m.statusMsg) + "\n")
	}

	// Help bar
	help := "j/k nav  enter expand/logs  r restart  R refresh  q quit"
	if m.expanded >= 0 {
		help = "j/k nav  enter logs  esc back  r restart  R refresh  q quit"
	}
	// Pad to bottom
	lines := strings.Count(b.String(), "\n")
	for i := lines; i < m.height-2; i++ {
		b.WriteString("\n")
	}
	b.WriteString(helpStyle.Render(help))

	return b.String()
}

func (m model) viewLogs() string {
	var b strings.Builder

	// Header
	header := fmt.Sprintf("%s/%s", m.logRepo, m.logInstance)
	b.WriteString(headerStyle.Render("logs") + "  " + titleStyle.Render(header) + "\n")
	b.WriteString(dimStyle.Render(strings.Repeat("─", min(m.width, 80))) + "\n")

	// Log lines with scroll
	viewHeight := m.height - 4
	end := min(m.logScroll+viewHeight, len(m.logLines))
	for i := m.logScroll; i < end; i++ {
		line := m.logLines[i]
		if len(line) > m.width-1 {
			line = line[:m.width-1]
		}
		b.WriteString(line + "\n")
	}

	// Pad
	rendered := end - m.logScroll
	for i := rendered; i < viewHeight; i++ {
		b.WriteString("\n")
	}

	// Scroll indicator + help
	pct := 0
	if len(m.logLines) > 0 {
		pct = (m.logScroll * 100) / max(1, len(m.logLines)-viewHeight)
	}
	help := fmt.Sprintf("j/k scroll  pgup/pgdn page  g/G top/bottom  R reload  esc back  q quit  [%d%%]", min(pct, 100))
	b.WriteString(helpStyle.Render(help))

	return b.String()
}

func main() {
	apiURL := os.Getenv("SEED_API_URL")
	if apiURL == "" {
		fmt.Fprintf(os.Stderr, "SEED_API_URL not set\n")
		os.Exit(1)
	}

	// Parse repos from SEED_REPOS env (same format as seed-shell)
	// Format: "name=namespace=identity,name2=namespace2=identity2"
	reposRaw := os.Getenv("SEED_REPOS")
	if reposRaw == "" {
		fmt.Fprintf(os.Stderr, "no repos available\n")
		os.Exit(1)
	}

	client := NewClient(apiURL)

	var repos []Repo
	for _, entry := range strings.Split(reposRaw, ",") {
		parts := strings.SplitN(entry, "=", 3)
		if len(parts) < 2 {
			continue
		}
		r := Repo{
			Name:      parts[0],
			Namespace: parts[1],
		}
		if len(parts) > 2 {
			r.Identity = parts[2]
		}
		repos = append(repos, r)
	}

	if len(repos) == 0 {
		fmt.Fprintf(os.Stderr, "no repos found\n")
		os.Exit(1)
	}

	p := tea.NewProgram(initialModel(client, repos), tea.WithAltScreen())
	if _, err := p.Run(); err != nil {
		fmt.Fprintf(os.Stderr, "error: %v\n", err)
		os.Exit(1)
	}
}
