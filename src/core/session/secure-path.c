/* Fixed-arity wrappers preserve the variadic openat ABI on macOS ARM64. No project code or headers. */
extern int openat(int, const char *, int, ...);
extern int mkdirat(int, const char *, unsigned int);
extern int renameat(int, const char *, int, const char *);
extern int linkat(int, const char *, int, const char *, int);
extern int unlinkat(int, const char *, int);
#ifdef CODESPLASH_DARWIN
extern int *__error(void);
#define cs_errno (*__error())
#else
extern int *__errno_location(void);
#define cs_errno (*__errno_location())
#endif
int cs_openat(int fd, const char *name, int flags, int mode) {
  int result = openat(fd, name, flags, mode); return result < 0 ? -cs_errno : result;
}
int cs_mkdirat(int fd, const char *name) {
  int result = mkdirat(fd, name, 0700); return result < 0 ? -cs_errno : result;
}
int cs_renameat(int fd, const char *from, const char *to) {
  int result = renameat(fd, from, fd, to); return result < 0 ? -cs_errno : result;
}
int cs_linkat(int fd, const char *from, const char *to) {
  int result = linkat(fd, from, fd, to, 0); return result < 0 ? -cs_errno : result;
}
int cs_unlinkat(int fd, const char *name) {
  int result = unlinkat(fd, name, 0); return result < 0 ? -cs_errno : result;
}
