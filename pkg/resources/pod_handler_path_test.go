package resources

import "testing"

func TestSafeExecPath(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"/etc/passwd", "/etc/passwd"},
		{"app/logs", "app/logs"},
		{"-version", "./-version"},
		{"--foo=bar", "./--foo=bar"},
		{"", ""},
	}
	for _, c := range cases {
		if got := safeExecPath(c.in); got != c.want {
			t.Errorf("safeExecPath(%q) = %q, want %q", c.in, got, c.want)
		}
	}
}

func TestValidateContainerPath(t *testing.T) {
	valid := []string{"/", "/etc", "/var/log/app.log", "relative/path", "/a/..b/c", "/..hidden"}
	for _, p := range valid {
		if err := validateContainerPath(p); err != nil {
			t.Errorf("validateContainerPath(%q) = %v, want nil", p, err)
		}
	}

	invalid := []string{"", "   ", "/etc/../shadow", "../../etc", "/var/../../etc", "a/../..", "/etc/\x00passwd"}
	for _, p := range invalid {
		if err := validateContainerPath(p); err == nil {
			t.Errorf("validateContainerPath(%q) = nil, want an error", p)
		}
	}
}
