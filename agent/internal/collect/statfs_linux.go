//go:build linux

package collect

import "syscall"

func statfs(path string) (total, used uint64, err error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(path, &st); err != nil {
		return 0, 0, err
	}
	bs := uint64(st.Frsize)
	if bs == 0 {
		bs = uint64(st.Bsize)
	}
	total = uint64(st.Blocks) * bs
	free := uint64(st.Bfree) * bs
	if free > total {
		free = total
	}
	return total, total - free, nil
}
