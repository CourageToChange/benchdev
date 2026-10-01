(module
  ;; The previous iteration's state is an operand of every update. The loop
  ;; index is mixed in as well, making the checksum depend on the exact count.
  (func (export "run") (param $count i32) (param $seed i32) (result i32)
    (local $index i32)
    (local $state i32)

    local.get $seed
    local.set $state

    block $done
      loop $next
        local.get $index
        local.get $count
        i32.ge_u
        br_if $done

        local.get $state
        local.get $index
        i32.const 1
        i32.add
        i32.xor
        i32.const 0x85ebca6b
        i32.mul
        i32.const 13
        i32.rotl
        local.get $index
        i32.const 1
        i32.add
        i32.const 0xc2b2ae35
        i32.mul
        i32.add
        local.set $state

        local.get $index
        i32.const 1
        i32.add
        local.set $index
        br $next
      end
    end

    local.get $state
  )
)
