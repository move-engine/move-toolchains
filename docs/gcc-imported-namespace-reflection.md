# GCC imported-namespace reflection qualification

## Status

This is a candidate compiler correction, not an upstreamed GCC fix and not yet
part of the normal Move toolchain installation path.

Move's declaration scanner needs to reflect a namespace imported from another
C++ module partition. The exact repository probe is published at Nez commit
`06105d7` on branch
`task/refined-cxx-modules-imported-namespace-probe`, under
`tests/toolchain/cxx_modules_reflection`.

The probe evaluates `std::meta::members_of(^^Move::Probe, ...)` from the scanner
partition after importing the partition that declares the namespace members.

## Qualification results

| Compiler source | Result | Evidence |
| --- | --- | --- |
| GCC 16.1.0 | Fails | Internal compiler error while inserting a namespace member into the duplicate-suppression set. |
| GCC 16.2.0 official release | Fails | Same failure boundary after an incremental frontend rebuild from the signed release archive. |
| GCC master `c090d57e384733d726fad8f61018a3c6d2c559f0` | Fails unmodified | GCC reports `17.0.0 20260820 (experimental)`; the exact probe fails in `walk_namespace_bindings`. |
| Same GCC master plus the candidate patch | Passes | The exact probe compiles, links, and executes successfully. GCC's directly related `reflect-2` and `reflect-3` tests also pass when compiled manually. |

The GCC 16.2 source archive used for qualification had SHA-256
`e6738e29597f733270731aa90600f37ffdc045079dfc27ec7e8192cc81085c3e`
and a valid GNU release signature. The GCC master archive had SHA-256
`7f8d525d2a51a16e893696cb73c249a1c64a6c6edbca4a60c98377a3b8433f78`.

The clean master compiler was configured as a non-bootstrap C/C++ frontend
build using the installed GCC 16.1 toolchain as host. Probe qualification used
that fresh `cc1plus` through the GCC driver's `-B` mechanism and the installed
GCC 16.1 standard-library headers. This isolates the frontend change without
overwriting `/opt/gcc/16.1.0`.

## Failure analysis

`walk_namespace_bindings` recognizes that module binding vectors can mention
the same entity more than once and inserts each candidate declaration into a
`hash_set<tree>` before invoking the reflection callback. For one imported
stat-hack binding, `STAT_TYPE_VISIBLE_P(bind)` is true while `STAT_TYPE(bind)`
is null. The unmodified code inserts that null tree into the set. GCC's hash-set
contract reserves the null tree as its empty key, so a checking build raises an
internal compiler error.

The inconsistent state originates in `set_module_binding`. For a same-module
partition in a public namespace, it sets `STAT_TYPE_VISIBLE_P(bind)` even when
the deserialized binding has no type. Most lookup consumers happen to tolerate
the resulting null type; the reflection walk tries to deduplicate it and
exposes the invalid state.

The candidate patch makes the visibility flag conditional on an associated
type. This preserves the intended rule that same-module partition types are
visible while avoiding a visibility claim for an absent type. The declaration
chain remains independently visible and the exact Nez program still discovers
`Record` at runtime. A minimized two-partition regression test verifies both
the reflected member count and identifier.

## Candidate patch

Apply
`patches/gcc/0001-cxx-reflection-skip-null-imported-stat-type.patch` to
the exact GCC master checkpoint above and rebuild `all-gcc`. The patch is kept
separate from installer automation until it has received an independent source
review and broader GCC tests. The patch includes the minimized GCC regression
pair as `reflect-4_a.C` and `reflect-4_b.C`.

Before adopting a patched compiler release:

1. rerun the Nez module/reflection probe from a clean build root;
2. run GCC's focused C++ modules and reflection tests, including a negative
   namespace-visibility case;
3. run the Nez reflection and external-project validation suites;
4. qualify Linux and Windows builds independently; and
5. either link an upstream GCC bug/fix or carry a versioned downstream patch
   with exact source identity in the release manifest.

The Bloomberg Clang/clangd result is a separate qualification lane. Success or
failure there does not close this GCC frontend defect.
