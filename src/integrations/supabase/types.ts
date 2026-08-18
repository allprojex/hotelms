export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      account_lockouts: {
        Row: {
          created_at: string
          email: string | null
          id: string
          ip: unknown
          locked_until: string
          reason: string
          released_at: string | null
          released_by: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          email?: string | null
          id?: string
          ip?: unknown
          locked_until: string
          reason?: string
          released_at?: string | null
          released_by?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          email?: string | null
          id?: string
          ip?: unknown
          locked_until?: string
          reason?: string
          released_at?: string | null
          released_by?: string | null
          user_id?: string | null
        }
        Relationships: []
      }
      accounting_periods: {
        Row: {
          created_at: string
          end_date: string
          id: string
          locked_at: string | null
          locked_by: string | null
          property_id: string
          start_date: string
          status: Database["public"]["Enums"]["period_status"]
        }
        Insert: {
          created_at?: string
          end_date: string
          id?: string
          locked_at?: string | null
          locked_by?: string | null
          property_id: string
          start_date: string
          status?: Database["public"]["Enums"]["period_status"]
        }
        Update: {
          created_at?: string
          end_date?: string
          id?: string
          locked_at?: string | null
          locked_by?: string | null
          property_id?: string
          start_date?: string
          status?: Database["public"]["Enums"]["period_status"]
        }
        Relationships: [
          {
            foreignKeyName: "accounting_periods_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      accounting_sync_runs: {
        Row: {
          csv_payload: string | null
          entries_count: number
          error: string | null
          finished_at: string | null
          from_date: string
          id: string
          is_test: boolean
          property_id: string
          response_body: string | null
          response_status: number | null
          started_at: string
          status: string
          target_id: string
          to_date: string
          triggered_by: string | null
        }
        Insert: {
          csv_payload?: string | null
          entries_count?: number
          error?: string | null
          finished_at?: string | null
          from_date: string
          id?: string
          is_test?: boolean
          property_id: string
          response_body?: string | null
          response_status?: number | null
          started_at?: string
          status?: string
          target_id: string
          to_date: string
          triggered_by?: string | null
        }
        Update: {
          csv_payload?: string | null
          entries_count?: number
          error?: string | null
          finished_at?: string | null
          from_date?: string
          id?: string
          is_test?: boolean
          property_id?: string
          response_body?: string | null
          response_status?: number | null
          started_at?: string
          status?: string
          target_id?: string
          to_date?: string
          triggered_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "accounting_sync_runs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accounting_sync_runs_target_id_fkey"
            columns: ["target_id"]
            isOneToOne: false
            referencedRelation: "accounting_sync_targets"
            referencedColumns: ["id"]
          },
        ]
      }
      accounting_sync_targets: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          last_sync_at: string | null
          last_sync_error: string | null
          last_sync_status: string | null
          name: string
          property_id: string
          schedule: string
          schedule_dow: number | null
          schedule_hour: number
          signing_secret: string
          updated_at: string
          webhook_url: string | null
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          last_sync_at?: string | null
          last_sync_error?: string | null
          last_sync_status?: string | null
          name: string
          property_id: string
          schedule?: string
          schedule_dow?: number | null
          schedule_hour?: number
          signing_secret?: string
          updated_at?: string
          webhook_url?: string | null
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          last_sync_at?: string | null
          last_sync_error?: string | null
          last_sync_status?: string | null
          name?: string
          property_id?: string
          schedule?: string
          schedule_dow?: number | null
          schedule_hour?: number
          signing_secret?: string
          updated_at?: string
          webhook_url?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "accounting_sync_targets_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      accounts: {
        Row: {
          code: string
          created_at: string
          currency: string | null
          id: string
          is_active: boolean
          name: string
          parent_id: string | null
          property_id: string
          system_key: string | null
          type: Database["public"]["Enums"]["account_type"]
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          currency?: string | null
          id?: string
          is_active?: boolean
          name: string
          parent_id?: string | null
          property_id: string
          system_key?: string | null
          type: Database["public"]["Enums"]["account_type"]
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          currency?: string | null
          id?: string
          is_active?: boolean
          name?: string
          parent_id?: string | null
          property_id?: string
          system_key?: string | null
          type?: Database["public"]["Enums"]["account_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "accounts_currency_fkey"
            columns: ["currency"]
            isOneToOne: false
            referencedRelation: "currencies"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "accounts_parent_id_fkey"
            columns: ["parent_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accounts_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_action_logs: {
        Row: {
          action: string
          actor_id: string | null
          after_snapshot: Json | null
          before_snapshot: Json | null
          browser: string | null
          created_at: string
          device_fingerprint: string | null
          entity_id: string | null
          entity_type: string
          full_name_snapshot: string | null
          id: string
          ip: string | null
          memo: string | null
          os: string | null
          property_id: string | null
          remarks: string | null
          role_snapshot: string | null
          session_id: string | null
          success: boolean
          user_agent: string | null
        }
        Insert: {
          action: string
          actor_id?: string | null
          after_snapshot?: Json | null
          before_snapshot?: Json | null
          browser?: string | null
          created_at?: string
          device_fingerprint?: string | null
          entity_id?: string | null
          entity_type: string
          full_name_snapshot?: string | null
          id?: string
          ip?: string | null
          memo?: string | null
          os?: string | null
          property_id?: string | null
          remarks?: string | null
          role_snapshot?: string | null
          session_id?: string | null
          success?: boolean
          user_agent?: string | null
        }
        Update: {
          action?: string
          actor_id?: string | null
          after_snapshot?: Json | null
          before_snapshot?: Json | null
          browser?: string | null
          created_at?: string
          device_fingerprint?: string | null
          entity_id?: string | null
          entity_type?: string
          full_name_snapshot?: string | null
          id?: string
          ip?: string | null
          memo?: string | null
          os?: string | null
          property_id?: string | null
          remarks?: string | null
          role_snapshot?: string | null
          session_id?: string | null
          success?: boolean
          user_agent?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "admin_action_logs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      analytics_export_runs: {
        Row: {
          created_at: string
          csv_payload: string | null
          error: string | null
          format: string
          html_report: string | null
          id: string
          period_from: string
          period_to: string
          property_id: string
          recipients: string[]
          schedule_id: string | null
          sent_at: string | null
          status: string
        }
        Insert: {
          created_at?: string
          csv_payload?: string | null
          error?: string | null
          format: string
          html_report?: string | null
          id?: string
          period_from: string
          period_to: string
          property_id: string
          recipients?: string[]
          schedule_id?: string | null
          sent_at?: string | null
          status?: string
        }
        Update: {
          created_at?: string
          csv_payload?: string | null
          error?: string | null
          format?: string
          html_report?: string | null
          id?: string
          period_from?: string
          period_to?: string
          property_id?: string
          recipients?: string[]
          schedule_id?: string | null
          sent_at?: string | null
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "analytics_export_runs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "analytics_export_runs_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "analytics_export_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      analytics_export_schedules: {
        Row: {
          created_at: string
          created_by: string | null
          day_of_month: number | null
          day_of_week: number | null
          format: string
          frequency: string
          hour: number
          id: string
          is_active: boolean
          last_run_at: string | null
          last_run_error: string | null
          last_run_status: string | null
          name: string
          next_run_at: string | null
          property_id: string
          recipients: string[]
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          day_of_month?: number | null
          day_of_week?: number | null
          format?: string
          frequency: string
          hour?: number
          id?: string
          is_active?: boolean
          last_run_at?: string | null
          last_run_error?: string | null
          last_run_status?: string | null
          name: string
          next_run_at?: string | null
          property_id: string
          recipients?: string[]
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          day_of_month?: number | null
          day_of_week?: number | null
          format?: string
          frequency?: string
          hour?: number
          id?: string
          is_active?: boolean
          last_run_at?: string | null
          last_run_error?: string | null
          last_run_status?: string | null
          name?: string
          next_run_at?: string | null
          property_id?: string
          recipients?: string[]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "analytics_export_schedules_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      ap_bill_lines: {
        Row: {
          bill_id: string
          created_at: string
          description: string
          expense_account_id: string | null
          id: string
          quantity: number
          tax_rate: number
          unit_price: number
        }
        Insert: {
          bill_id: string
          created_at?: string
          description: string
          expense_account_id?: string | null
          id?: string
          quantity?: number
          tax_rate?: number
          unit_price?: number
        }
        Update: {
          bill_id?: string
          created_at?: string
          description?: string
          expense_account_id?: string | null
          id?: string
          quantity?: number
          tax_rate?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "ap_bill_lines_bill_id_fkey"
            columns: ["bill_id"]
            isOneToOne: false
            referencedRelation: "ap_aging"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ap_bill_lines_bill_id_fkey"
            columns: ["bill_id"]
            isOneToOne: false
            referencedRelation: "ap_bills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ap_bill_lines_expense_account_id_fkey"
            columns: ["expense_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      ap_bills: {
        Row: {
          amount_paid: number
          bill_date: string
          code: string
          created_at: string
          created_by: string | null
          currency: string
          due_date: string
          id: string
          notes: string | null
          po_id: string | null
          posted_entry_id: string | null
          property_id: string
          reference: string | null
          status: Database["public"]["Enums"]["ap_status"]
          subtotal: number
          supplier_id: string | null
          supplier_name: string
          tax: number
          total: number
          updated_at: string
        }
        Insert: {
          amount_paid?: number
          bill_date?: string
          code: string
          created_at?: string
          created_by?: string | null
          currency?: string
          due_date?: string
          id?: string
          notes?: string | null
          po_id?: string | null
          posted_entry_id?: string | null
          property_id: string
          reference?: string | null
          status?: Database["public"]["Enums"]["ap_status"]
          subtotal?: number
          supplier_id?: string | null
          supplier_name: string
          tax?: number
          total?: number
          updated_at?: string
        }
        Update: {
          amount_paid?: number
          bill_date?: string
          code?: string
          created_at?: string
          created_by?: string | null
          currency?: string
          due_date?: string
          id?: string
          notes?: string | null
          po_id?: string | null
          posted_entry_id?: string | null
          property_id?: string
          reference?: string | null
          status?: Database["public"]["Enums"]["ap_status"]
          subtotal?: number
          supplier_id?: string | null
          supplier_name?: string
          tax?: number
          total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ap_bills_po_id_fkey"
            columns: ["po_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ap_bills_posted_entry_id_fkey"
            columns: ["posted_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ap_bills_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ap_bills_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      ap_payments: {
        Row: {
          amount: number
          bill_id: string
          created_at: string
          created_by: string | null
          id: string
          method: Database["public"]["Enums"]["payment_method"]
          paid_at: string
          posted_entry_id: string | null
          property_id: string
          reference: string | null
        }
        Insert: {
          amount: number
          bill_id: string
          created_at?: string
          created_by?: string | null
          id?: string
          method?: Database["public"]["Enums"]["payment_method"]
          paid_at?: string
          posted_entry_id?: string | null
          property_id: string
          reference?: string | null
        }
        Update: {
          amount?: number
          bill_id?: string
          created_at?: string
          created_by?: string | null
          id?: string
          method?: Database["public"]["Enums"]["payment_method"]
          paid_at?: string
          posted_entry_id?: string | null
          property_id?: string
          reference?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ap_payments_bill_id_fkey"
            columns: ["bill_id"]
            isOneToOne: false
            referencedRelation: "ap_aging"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ap_payments_bill_id_fkey"
            columns: ["bill_id"]
            isOneToOne: false
            referencedRelation: "ap_bills"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ap_payments_posted_entry_id_fkey"
            columns: ["posted_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ap_payments_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      ar_customers: {
        Row: {
          account_code: string
          active: boolean
          address: string | null
          created_at: string
          created_by: string | null
          email: string | null
          id: string
          name: string
          phone: string | null
          property_id: string
          updated_at: string
        }
        Insert: {
          account_code?: string
          active?: boolean
          address?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          name: string
          phone?: string | null
          property_id: string
          updated_at?: string
        }
        Update: {
          account_code?: string
          active?: boolean
          address?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          id?: string
          name?: string
          phone?: string | null
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ar_customers_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      ar_invoice_lines: {
        Row: {
          created_at: string
          description: string
          id: string
          invoice_id: string
          quantity: number
          revenue_account_id: string | null
          tax_rate: number
          unit_price: number
        }
        Insert: {
          created_at?: string
          description: string
          id?: string
          invoice_id: string
          quantity?: number
          revenue_account_id?: string | null
          tax_rate?: number
          unit_price?: number
        }
        Update: {
          created_at?: string
          description?: string
          id?: string
          invoice_id?: string
          quantity?: number
          revenue_account_id?: string | null
          tax_rate?: number
          unit_price?: number
        }
        Relationships: [
          {
            foreignKeyName: "ar_invoice_lines_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "ar_aging"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ar_invoice_lines_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "ar_invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ar_invoice_lines_revenue_account_id_fkey"
            columns: ["revenue_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
        ]
      }
      ar_invoices: {
        Row: {
          amount_paid: number
          bill_to_address: string | null
          bill_to_email: string | null
          bill_to_name: string
          code: string
          created_at: string
          created_by: string | null
          customer_id: string | null
          currency: string
          due_date: string
          id: string
          issue_date: string
          notes: string | null
          posted_entry_id: string | null
          property_id: string
          reservation_id: string | null
          status: Database["public"]["Enums"]["ar_status"]
          subtotal: number
          tax: number
          total: number
          updated_at: string
        }
        Insert: {
          amount_paid?: number
          bill_to_address?: string | null
          bill_to_email?: string | null
          bill_to_name: string
          code: string
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          currency?: string
          due_date?: string
          id?: string
          issue_date?: string
          notes?: string | null
          posted_entry_id?: string | null
          property_id: string
          reservation_id?: string | null
          status?: Database["public"]["Enums"]["ar_status"]
          subtotal?: number
          tax?: number
          total?: number
          updated_at?: string
        }
        Update: {
          amount_paid?: number
          bill_to_address?: string | null
          bill_to_email?: string | null
          bill_to_name?: string
          code?: string
          created_at?: string
          created_by?: string | null
          customer_id?: string | null
          currency?: string
          due_date?: string
          id?: string
          issue_date?: string
          notes?: string | null
          posted_entry_id?: string | null
          property_id?: string
          reservation_id?: string | null
          status?: Database["public"]["Enums"]["ar_status"]
          subtotal?: number
          tax?: number
          total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "ar_invoices_customer_fkey"
            columns: ["customer_id"]
            isOneToOne: false
            referencedRelation: "ar_customers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ar_invoices_posted_entry_id_fkey"
            columns: ["posted_entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ar_invoices_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ar_invoices_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
        ]
      }
      audit_logs: {
        Row: {
          action: string
          created_at: string
          entity: string | null
          entity_id: string | null
          id: string
          meta: Json | null
          property_id: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          meta?: Json | null
          property_id?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          entity?: string | null
          entity_id?: string | null
          id?: string
          meta?: Json | null
          property_id?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      backup_schedules: {
        Row: {
          created_at: string
          created_by: string | null
          day_of_month: number | null
          day_of_week: number | null
          enabled: boolean
          frequency: string
          hour_utc: number
          id: string
          kind: string
          last_run_at: string | null
          last_snapshot_id: string | null
          name: string
          next_run_at: string | null
          property_id: string | null
          retention_count: number
          scope: string
          tables: string[] | null
          updated_at: string
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          day_of_month?: number | null
          day_of_week?: number | null
          enabled?: boolean
          frequency?: string
          hour_utc?: number
          id?: string
          kind?: string
          last_run_at?: string | null
          last_snapshot_id?: string | null
          name: string
          next_run_at?: string | null
          property_id?: string | null
          retention_count?: number
          scope: string
          tables?: string[] | null
          updated_at?: string
        }
        Update: {
          created_at?: string
          created_by?: string | null
          day_of_month?: number | null
          day_of_week?: number | null
          enabled?: boolean
          frequency?: string
          hour_utc?: number
          id?: string
          kind?: string
          last_run_at?: string | null
          last_snapshot_id?: string | null
          name?: string
          next_run_at?: string | null
          property_id?: string | null
          retention_count?: number
          scope?: string
          tables?: string[] | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "backup_schedules_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      backup_snapshots: {
        Row: {
          created_at: string
          duration_ms: number | null
          error: string | null
          id: string
          kind: string
          property_id: string | null
          row_count: number | null
          schedule_id: string | null
          scope: string
          since_at: string | null
          size_bytes: number | null
          status: string
          storage_path: string | null
          table_counts: Json
          triggered_by: string | null
          until_at: string | null
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          kind: string
          property_id?: string | null
          row_count?: number | null
          schedule_id?: string | null
          scope: string
          since_at?: string | null
          size_bytes?: number | null
          status?: string
          storage_path?: string | null
          table_counts?: Json
          triggered_by?: string | null
          until_at?: string | null
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          error?: string | null
          id?: string
          kind?: string
          property_id?: string | null
          row_count?: number | null
          schedule_id?: string | null
          scope?: string
          since_at?: string | null
          size_bytes?: number | null
          status?: string
          storage_path?: string | null
          table_counts?: Json
          triggered_by?: string | null
          until_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "backup_snapshots_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "backup_snapshots_schedule_id_fkey"
            columns: ["schedule_id"]
            isOneToOne: false
            referencedRelation: "backup_schedules"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_rate_mappings: {
        Row: {
          channel_id: string
          created_at: string
          external_rate_code: string
          id: string
          rate_plan_id: string
        }
        Insert: {
          channel_id: string
          created_at?: string
          external_rate_code: string
          id?: string
          rate_plan_id: string
        }
        Update: {
          channel_id?: string
          created_at?: string
          external_rate_code?: string
          id?: string
          rate_plan_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_rate_mappings_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_rate_mappings_rate_plan_id_fkey"
            columns: ["rate_plan_id"]
            isOneToOne: false
            referencedRelation: "rate_plans"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_reservations_queue: {
        Row: {
          channel_id: string
          created_at: string
          error: string | null
          external_ref: string
          id: string
          payload: Json
          processed_at: string | null
          property_id: string
          reservation_id: string | null
          status: Database["public"]["Enums"]["channel_queue_status"]
        }
        Insert: {
          channel_id: string
          created_at?: string
          error?: string | null
          external_ref: string
          id?: string
          payload: Json
          processed_at?: string | null
          property_id: string
          reservation_id?: string | null
          status?: Database["public"]["Enums"]["channel_queue_status"]
        }
        Update: {
          channel_id?: string
          created_at?: string
          error?: string | null
          external_ref?: string
          id?: string
          payload?: Json
          processed_at?: string | null
          property_id?: string
          reservation_id?: string | null
          status?: Database["public"]["Enums"]["channel_queue_status"]
        }
        Relationships: [
          {
            foreignKeyName: "channel_reservations_queue_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_reservations_queue_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_reservations_queue_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_room_mappings: {
        Row: {
          channel_id: string
          created_at: string
          external_room_code: string
          id: string
          room_type_id: string
        }
        Insert: {
          channel_id: string
          created_at?: string
          external_room_code: string
          id?: string
          room_type_id: string
        }
        Update: {
          channel_id?: string
          created_at?: string
          external_room_code?: string
          id?: string
          room_type_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "channel_room_mappings_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_room_mappings_room_type_id_fkey"
            columns: ["room_type_id"]
            isOneToOne: false
            referencedRelation: "room_types"
            referencedColumns: ["id"]
          },
        ]
      }
      channel_sync_logs: {
        Row: {
          channel_id: string
          created_at: string
          direction: Database["public"]["Enums"]["channel_sync_direction"]
          duration_ms: number
          id: string
          message: string | null
          payload: Json
          property_id: string
          status: Database["public"]["Enums"]["channel_sync_status"]
        }
        Insert: {
          channel_id: string
          created_at?: string
          direction: Database["public"]["Enums"]["channel_sync_direction"]
          duration_ms?: number
          id?: string
          message?: string | null
          payload?: Json
          property_id: string
          status: Database["public"]["Enums"]["channel_sync_status"]
        }
        Update: {
          channel_id?: string
          created_at?: string
          direction?: Database["public"]["Enums"]["channel_sync_direction"]
          duration_ms?: number
          id?: string
          message?: string | null
          payload?: Json
          property_id?: string
          status?: Database["public"]["Enums"]["channel_sync_status"]
        }
        Relationships: [
          {
            foreignKeyName: "channel_sync_logs_channel_id_fkey"
            columns: ["channel_id"]
            isOneToOne: false
            referencedRelation: "channels"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "channel_sync_logs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      channels: {
        Row: {
          created_at: string
          external_hotel_id: string | null
          id: string
          is_active: boolean
          last_sync_at: string | null
          last_sync_error: string | null
          last_sync_status: Database["public"]["Enums"]["channel_sync_status"]
          name: string
          property_id: string
          type: Database["public"]["Enums"]["channel_type"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          external_hotel_id?: string | null
          id?: string
          is_active?: boolean
          last_sync_at?: string | null
          last_sync_error?: string | null
          last_sync_status?: Database["public"]["Enums"]["channel_sync_status"]
          name: string
          property_id: string
          type?: Database["public"]["Enums"]["channel_type"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          external_hotel_id?: string | null
          id?: string
          is_active?: boolean
          last_sync_at?: string | null
          last_sync_error?: string | null
          last_sync_status?: Database["public"]["Enums"]["channel_sync_status"]
          name?: string
          property_id?: string
          type?: Database["public"]["Enums"]["channel_type"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "channels_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      currencies: {
        Row: {
          code: string
          created_at: string
          decimals: number
          name: string
          symbol: string
        }
        Insert: {
          code: string
          created_at?: string
          decimals?: number
          name: string
          symbol: string
        }
        Update: {
          code?: string
          created_at?: string
          decimals?: number
          name?: string
          symbol?: string
        }
        Relationships: []
      }
      custom_roles: {
        Row: {
          created_at: string
          created_by: string | null
          description: string | null
          id: string
          key: string
          name: string
          property_id: string | null
        }
        Insert: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          key: string
          name: string
          property_id?: string | null
        }
        Update: {
          created_at?: string
          created_by?: string | null
          description?: string | null
          id?: string
          key?: string
          name?: string
          property_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "custom_roles_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      data_upload_rows: {
        Row: {
          error: string | null
          id: string
          payload: Json
          row_index: number
          status: string
          upload_id: string
        }
        Insert: {
          error?: string | null
          id?: string
          payload: Json
          row_index: number
          status?: string
          upload_id: string
        }
        Update: {
          error?: string | null
          id?: string
          payload?: Json
          row_index?: number
          status?: string
          upload_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "data_upload_rows_upload_id_fkey"
            columns: ["upload_id"]
            isOneToOne: false
            referencedRelation: "data_uploads"
            referencedColumns: ["id"]
          },
        ]
      }
      data_uploads: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          created_at: string
          errors: Json
          filename: string
          id: string
          property_id: string
          row_count: number
          status: string
          storage_path: string | null
          summary: Json
          target_kind: string
          updated_at: string
          uploaded_by: string | null
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          errors?: Json
          filename: string
          id?: string
          property_id: string
          row_count?: number
          status?: string
          storage_path?: string | null
          summary?: Json
          target_kind: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          created_at?: string
          errors?: Json
          filename?: string
          id?: string
          property_id?: string
          row_count?: number
          status?: string
          storage_path?: string | null
          summary?: Json
          target_kind?: string
          updated_at?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "data_uploads_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      esl_devices: {
        Row: {
          address: string | null
          connection: string
          created_at: string
          id: string
          kind: string
          last_seen_at: string | null
          metadata: Json
          model: string | null
          name: string
          notes: string | null
          property_id: string
          status: string
          updated_at: string
          vendor: string | null
        }
        Insert: {
          address?: string | null
          connection: string
          created_at?: string
          id?: string
          kind: string
          last_seen_at?: string | null
          metadata?: Json
          model?: string | null
          name: string
          notes?: string | null
          property_id: string
          status?: string
          updated_at?: string
          vendor?: string | null
        }
        Update: {
          address?: string | null
          connection?: string
          created_at?: string
          id?: string
          kind?: string
          last_seen_at?: string | null
          metadata?: Json
          model?: string | null
          name?: string
          notes?: string | null
          property_id?: string
          status?: string
          updated_at?: string
          vendor?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "esl_devices_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      esl_labels: {
        Row: {
          barcode_type: string | null
          created_at: string
          custom_text: string | null
          id: string
          inventory_item_id: string | null
          label_code: string | null
          last_synced_at: string | null
          pos_menu_item_id: string | null
          price_override: number | null
          property_id: string
          sync_status: string | null
          template_id: string | null
          updated_at: string
        }
        Insert: {
          barcode_type?: string | null
          created_at?: string
          custom_text?: string | null
          id?: string
          inventory_item_id?: string | null
          label_code?: string | null
          last_synced_at?: string | null
          pos_menu_item_id?: string | null
          price_override?: number | null
          property_id: string
          sync_status?: string | null
          template_id?: string | null
          updated_at?: string
        }
        Update: {
          barcode_type?: string | null
          created_at?: string
          custom_text?: string | null
          id?: string
          inventory_item_id?: string | null
          label_code?: string | null
          last_synced_at?: string | null
          pos_menu_item_id?: string | null
          price_override?: number | null
          property_id?: string
          sync_status?: string | null
          template_id?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "esl_labels_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "esl_labels_pos_menu_item_id_fkey"
            columns: ["pos_menu_item_id"]
            isOneToOne: false
            referencedRelation: "pos_menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "esl_labels_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "esl_labels_template_id_fkey"
            columns: ["template_id"]
            isOneToOne: false
            referencedRelation: "esl_templates"
            referencedColumns: ["id"]
          },
        ]
      }
      esl_pairing_codes: {
        Row: {
          code: string
          connection: string
          consumed_at: string | null
          created_at: string
          created_by: string | null
          device_id: string | null
          expires_at: string
          id: string
          kind: string
          property_id: string
          suggested_name: string | null
          updated_at: string
        }
        Insert: {
          code: string
          connection: string
          consumed_at?: string | null
          created_at?: string
          created_by?: string | null
          device_id?: string | null
          expires_at?: string
          id?: string
          kind: string
          property_id: string
          suggested_name?: string | null
          updated_at?: string
        }
        Update: {
          code?: string
          connection?: string
          consumed_at?: string | null
          created_at?: string
          created_by?: string | null
          device_id?: string | null
          expires_at?: string
          id?: string
          kind?: string
          property_id?: string
          suggested_name?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "esl_pairing_codes_device_id_fkey"
            columns: ["device_id"]
            isOneToOne: false
            referencedRelation: "esl_devices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "esl_pairing_codes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      esl_sync_batches: {
        Row: {
          completed_at: string | null
          created_at: string
          created_by: string | null
          error: string | null
          file_url: string | null
          format: string
          id: string
          label_count: number
          property_id: string
          status: string
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          file_url?: string | null
          format?: string
          id?: string
          label_count?: number
          property_id: string
          status?: string
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error?: string | null
          file_url?: string | null
          format?: string
          id?: string
          label_count?: number
          property_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "esl_sync_batches_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      esl_templates: {
        Row: {
          active: boolean
          created_at: string
          height_mm: number
          id: string
          layout: Json
          name: string
          property_id: string
          updated_at: string
          width_mm: number
        }
        Insert: {
          active?: boolean
          created_at?: string
          height_mm?: number
          id?: string
          layout?: Json
          name: string
          property_id: string
          updated_at?: string
          width_mm?: number
        }
        Update: {
          active?: boolean
          created_at?: string
          height_mm?: number
          id?: string
          layout?: Json
          name?: string
          property_id?: string
          updated_at?: string
          width_mm?: number
        }
        Relationships: [
          {
            foreignKeyName: "esl_templates_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      failed_login_attempts: {
        Row: {
          attempted_at: string
          email: string
          id: string
          ip: unknown
          user_agent: string | null
        }
        Insert: {
          attempted_at?: string
          email: string
          id?: string
          ip?: unknown
          user_agent?: string | null
        }
        Update: {
          attempted_at?: string
          email?: string
          id?: string
          ip?: unknown
          user_agent?: string | null
        }
        Relationships: []
      }
      file_scan_logs: {
        Row: {
          created_at: string
          file_name: string
          file_size: number
          heuristics: Json
          id: string
          mime_type: string | null
          property_id: string | null
          quarantined: boolean
          reason: string | null
          scanned_by: string | null
          sha256: string
          verdict: string
          vt_harmless: number | null
          vt_malicious: number | null
          vt_result: Json | null
          vt_suspicious: number | null
          vt_undetected: number | null
        }
        Insert: {
          created_at?: string
          file_name: string
          file_size: number
          heuristics?: Json
          id?: string
          mime_type?: string | null
          property_id?: string | null
          quarantined?: boolean
          reason?: string | null
          scanned_by?: string | null
          sha256: string
          verdict: string
          vt_harmless?: number | null
          vt_malicious?: number | null
          vt_result?: Json | null
          vt_suspicious?: number | null
          vt_undetected?: number | null
        }
        Update: {
          created_at?: string
          file_name?: string
          file_size?: number
          heuristics?: Json
          id?: string
          mime_type?: string | null
          property_id?: string | null
          quarantined?: boolean
          reason?: string | null
          scanned_by?: string | null
          sha256?: string
          verdict?: string
          vt_harmless?: number | null
          vt_malicious?: number | null
          vt_result?: Json | null
          vt_suspicious?: number | null
          vt_undetected?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "file_scan_logs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      fx_rates: {
        Row: {
          as_of_date: string
          created_at: string
          from_code: string
          id: string
          property_id: string
          rate: number
          to_code: string
        }
        Insert: {
          as_of_date: string
          created_at?: string
          from_code: string
          id?: string
          property_id: string
          rate: number
          to_code: string
        }
        Update: {
          as_of_date?: string
          created_at?: string
          from_code?: string
          id?: string
          property_id?: string
          rate?: number
          to_code?: string
        }
        Relationships: [
          {
            foreignKeyName: "fx_rates_from_code_fkey"
            columns: ["from_code"]
            isOneToOne: false
            referencedRelation: "currencies"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "fx_rates_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "fx_rates_to_code_fkey"
            columns: ["to_code"]
            isOneToOne: false
            referencedRelation: "currencies"
            referencedColumns: ["code"]
          },
        ]
      }
      guest_id_types: {
        Row: {
          active: boolean
          code: string
          created_at: string
          id: string
          is_system: boolean
          name: string
          property_id: string | null
        }
        Insert: {
          active?: boolean
          code: string
          created_at?: string
          id?: string
          is_system?: boolean
          name: string
          property_id?: string | null
        }
        Update: {
          active?: boolean
          code?: string
          created_at?: string
          id?: string
          is_system?: boolean
          name?: string
          property_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "guest_id_types_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      guests: {
        Row: {
          address: string | null
          created_at: string
          created_by: string | null
          email: string | null
          first_name: string
          id: string
          id_number: string | null
          id_type: string | null
          id_type_id: string | null
          last_name: string
          nationality: string | null
          nationality_code: string | null
          notes: string | null
          phone: string | null
          property_id: string
          region_capital: string | null
          region_code: string | null
          updated_at: string
          vip: boolean
        }
        Insert: {
          address?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          first_name: string
          id?: string
          id_number?: string | null
          id_type?: string | null
          id_type_id?: string | null
          last_name: string
          nationality?: string | null
          nationality_code?: string | null
          notes?: string | null
          phone?: string | null
          property_id: string
          region_capital?: string | null
          region_code?: string | null
          updated_at?: string
          vip?: boolean
        }
        Update: {
          address?: string | null
          created_at?: string
          created_by?: string | null
          email?: string | null
          first_name?: string
          id?: string
          id_number?: string | null
          id_type?: string | null
          id_type_id?: string | null
          last_name?: string
          nationality?: string | null
          nationality_code?: string | null
          notes?: string | null
          phone?: string | null
          property_id?: string
          region_capital?: string | null
          region_code?: string | null
          updated_at?: string
          vip?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "guests_id_type_id_fkey"
            columns: ["id_type_id"]
            isOneToOne: false
            referencedRelation: "guest_id_types"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "guests_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      inventory_items: {
        Row: {
          active: boolean
          category_id: string | null
          cost: number
          created_at: string
          id: string
          image_path: string | null
          image_source: string | null
          image_updated_at: string | null
          name: string
          property_id: string
          reorder_level: number
          sale_price: number
          sku: string
          unit: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          category_id?: string | null
          cost?: number
          created_at?: string
          id?: string
          image_path?: string | null
          image_source?: string | null
          image_updated_at?: string | null
          name: string
          property_id: string
          reorder_level?: number
          sale_price?: number
          sku: string
          unit?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          category_id?: string | null
          cost?: number
          created_at?: string
          id?: string
          image_path?: string | null
          image_source?: string | null
          image_updated_at?: string | null
          name?: string
          property_id?: string
          reorder_level?: number
          sale_price?: number
          sku?: string
          unit?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "inventory_items_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "item_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inventory_items_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          id: string
          issued_at: string
          number: string
          paid: number
          reservation_id: string
          subtotal: number
          tax: number
          total: number
        }
        Insert: {
          id?: string
          issued_at?: string
          number: string
          paid?: number
          reservation_id: string
          subtotal?: number
          tax?: number
          total?: number
        }
        Update: {
          id?: string
          issued_at?: string
          number?: string
          paid?: number
          reservation_id?: string
          subtotal?: number
          tax?: number
          total?: number
        }
        Relationships: [
          {
            foreignKeyName: "invoices_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
        ]
      }
      item_categories: {
        Row: {
          created_at: string
          id: string
          name: string
          property_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          name: string
          property_id: string
        }
        Update: {
          created_at?: string
          id?: string
          name?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "item_categories_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      item_stock: {
        Row: {
          id: string
          item_id: string
          location_id: string
          property_id: string
          quantity: number
          updated_at: string
        }
        Insert: {
          id?: string
          item_id: string
          location_id: string
          property_id: string
          quantity?: number
          updated_at?: string
        }
        Update: {
          id?: string
          item_id?: string
          location_id?: string
          property_id?: string
          quantity?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "item_stock_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "item_stock_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "stock_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "item_stock_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      journal_entries: {
        Row: {
          created_at: string
          currency: string
          entry_date: string
          id: string
          is_reversal_of: string | null
          memo: string | null
          period_id: string | null
          posted_at: string
          posted_by: string | null
          property_id: string
          source: Database["public"]["Enums"]["journal_source"]
          source_ref: string | null
        }
        Insert: {
          created_at?: string
          currency: string
          entry_date: string
          id?: string
          is_reversal_of?: string | null
          memo?: string | null
          period_id?: string | null
          posted_at?: string
          posted_by?: string | null
          property_id: string
          source?: Database["public"]["Enums"]["journal_source"]
          source_ref?: string | null
        }
        Update: {
          created_at?: string
          currency?: string
          entry_date?: string
          id?: string
          is_reversal_of?: string | null
          memo?: string | null
          period_id?: string | null
          posted_at?: string
          posted_by?: string | null
          property_id?: string
          source?: Database["public"]["Enums"]["journal_source"]
          source_ref?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "journal_entries_currency_fkey"
            columns: ["currency"]
            isOneToOne: false
            referencedRelation: "currencies"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "journal_entries_is_reversal_of_fkey"
            columns: ["is_reversal_of"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_period_id_fkey"
            columns: ["period_id"]
            isOneToOne: false
            referencedRelation: "accounting_periods"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_entries_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      journal_lines: {
        Row: {
          account_id: string
          created_at: string
          credit: number
          credit_base: number
          currency: string
          debit: number
          debit_base: number
          entry_id: string
          fx_rate: number
          id: string
          memo: string | null
        }
        Insert: {
          account_id: string
          created_at?: string
          credit?: number
          credit_base?: number
          currency: string
          debit?: number
          debit_base?: number
          entry_id: string
          fx_rate?: number
          id?: string
          memo?: string | null
        }
        Update: {
          account_id?: string
          created_at?: string
          credit?: number
          credit_base?: number
          currency?: string
          debit?: number
          debit_base?: number
          entry_id?: string
          fx_rate?: number
          id?: string
          memo?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "journal_lines_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "journal_lines_currency_fkey"
            columns: ["currency"]
            isOneToOne: false
            referencedRelation: "currencies"
            referencedColumns: ["code"]
          },
          {
            foreignKeyName: "journal_lines_entry_id_fkey"
            columns: ["entry_id"]
            isOneToOne: false
            referencedRelation: "journal_entries"
            referencedColumns: ["id"]
          },
        ]
      }
      night_audits: {
        Row: {
          arrivals: number
          business_date: string
          cash_in: number
          departures: number
          errors: Json
          fnb_revenue: number
          id: string
          no_shows: number
          payments_posted: number
          period_locked: boolean
          pos_orders_posted: number
          property_id: string
          ran_at: string
          ran_by: string | null
          reservations_posted: number
          room_revenue: number
          rooms_occupied: number
          status: Database["public"]["Enums"]["night_audit_status"]
          tax_collected: number
          warnings: Json
        }
        Insert: {
          arrivals?: number
          business_date: string
          cash_in?: number
          departures?: number
          errors?: Json
          fnb_revenue?: number
          id?: string
          no_shows?: number
          payments_posted?: number
          period_locked?: boolean
          pos_orders_posted?: number
          property_id: string
          ran_at?: string
          ran_by?: string | null
          reservations_posted?: number
          room_revenue?: number
          rooms_occupied?: number
          status?: Database["public"]["Enums"]["night_audit_status"]
          tax_collected?: number
          warnings?: Json
        }
        Update: {
          arrivals?: number
          business_date?: string
          cash_in?: number
          departures?: number
          errors?: Json
          fnb_revenue?: number
          id?: string
          no_shows?: number
          payments_posted?: number
          period_locked?: boolean
          pos_orders_posted?: number
          property_id?: string
          ran_at?: string
          ran_by?: string | null
          reservations_posted?: number
          room_revenue?: number
          rooms_occupied?: number
          status?: Database["public"]["Enums"]["night_audit_status"]
          tax_collected?: number
          warnings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "night_audits_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      notifications: {
        Row: {
          body: string | null
          category: string
          created_at: string
          id: string
          link: string | null
          metadata: Json
          priority: string
          property_id: string | null
          read_at: string | null
          title: string
          user_id: string | null
        }
        Insert: {
          body?: string | null
          category: string
          created_at?: string
          id?: string
          link?: string | null
          metadata?: Json
          priority?: string
          property_id?: string | null
          read_at?: string | null
          title: string
          user_id?: string | null
        }
        Update: {
          body?: string | null
          category?: string
          created_at?: string
          id?: string
          link?: string | null
          metadata?: Json
          priority?: string
          property_id?: string | null
          read_at?: string | null
          title?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "notifications_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          id: string
          method: Database["public"]["Enums"]["payment_method"]
          received_at: string
          received_by: string | null
          reference: string | null
          reservation_id: string
        }
        Insert: {
          amount: number
          id?: string
          method: Database["public"]["Enums"]["payment_method"]
          received_at?: string
          received_by?: string | null
          reference?: string | null
          reservation_id: string
        }
        Update: {
          amount?: number
          id?: string
          method?: Database["public"]["Enums"]["payment_method"]
          received_at?: string
          received_by?: string | null
          reference?: string | null
          reservation_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_kots: {
        Row: {
          code: string
          fired_at: string
          fired_by: string | null
          id: string
          order_id: string
        }
        Insert: {
          code: string
          fired_at?: string
          fired_by?: string | null
          id?: string
          order_id: string
        }
        Update: {
          code?: string
          fired_at?: string
          fired_by?: string | null
          id?: string
          order_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_kots_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "pos_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_menu_categories: {
        Row: {
          id: string
          name: string
          outlet_id: string
          property_id: string
          sort: number
        }
        Insert: {
          id?: string
          name: string
          outlet_id: string
          property_id: string
          sort?: number
        }
        Update: {
          id?: string
          name?: string
          outlet_id?: string
          property_id?: string
          sort?: number
        }
        Relationships: [
          {
            foreignKeyName: "pos_menu_categories_outlet_id_fkey"
            columns: ["outlet_id"]
            isOneToOne: false
            referencedRelation: "pos_outlets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_menu_categories_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_menu_items: {
        Row: {
          active: boolean
          category_id: string | null
          created_at: string
          description: string | null
          id: string
          inventory_item_id: string | null
          name: string
          outlet_id: string
          price: number
          property_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          category_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          inventory_item_id?: string | null
          name: string
          outlet_id: string
          price?: number
          property_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          category_id?: string | null
          created_at?: string
          description?: string | null
          id?: string
          inventory_item_id?: string | null
          name?: string
          outlet_id?: string
          price?: number
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_menu_items_category_id_fkey"
            columns: ["category_id"]
            isOneToOne: false
            referencedRelation: "pos_menu_categories"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_menu_items_inventory_item_id_fkey"
            columns: ["inventory_item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_menu_items_outlet_id_fkey"
            columns: ["outlet_id"]
            isOneToOne: false
            referencedRelation: "pos_outlets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_menu_items_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_order_items: {
        Row: {
          created_at: string
          id: string
          kot_fired_at: string | null
          menu_item_id: string | null
          name_snapshot: string
          notes: string | null
          order_id: string
          price_snapshot: number
          quantity: number
        }
        Insert: {
          created_at?: string
          id?: string
          kot_fired_at?: string | null
          menu_item_id?: string | null
          name_snapshot: string
          notes?: string | null
          order_id: string
          price_snapshot: number
          quantity?: number
        }
        Update: {
          created_at?: string
          id?: string
          kot_fired_at?: string | null
          menu_item_id?: string | null
          name_snapshot?: string
          notes?: string | null
          order_id?: string
          price_snapshot?: number
          quantity?: number
        }
        Relationships: [
          {
            foreignKeyName: "pos_order_items_menu_item_id_fkey"
            columns: ["menu_item_id"]
            isOneToOne: false
            referencedRelation: "pos_menu_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_order_items_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "pos_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_orders: {
        Row: {
          closed_at: string | null
          code: string
          created_at: string
          created_by: string | null
          guest_name: string | null
          id: string
          opened_at: string
          outlet_id: string
          property_id: string
          reservation_id: string | null
          status: Database["public"]["Enums"]["pos_order_status"]
          subtotal: number
          table_id: string | null
          tax: number
          total: number
          updated_at: string
        }
        Insert: {
          closed_at?: string | null
          code: string
          created_at?: string
          created_by?: string | null
          guest_name?: string | null
          id?: string
          opened_at?: string
          outlet_id: string
          property_id: string
          reservation_id?: string | null
          status?: Database["public"]["Enums"]["pos_order_status"]
          subtotal?: number
          table_id?: string | null
          tax?: number
          total?: number
          updated_at?: string
        }
        Update: {
          closed_at?: string | null
          code?: string
          created_at?: string
          created_by?: string | null
          guest_name?: string | null
          id?: string
          opened_at?: string
          outlet_id?: string
          property_id?: string
          reservation_id?: string | null
          status?: Database["public"]["Enums"]["pos_order_status"]
          subtotal?: number
          table_id?: string | null
          tax?: number
          total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_orders_outlet_id_fkey"
            columns: ["outlet_id"]
            isOneToOne: false
            referencedRelation: "pos_outlets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_orders_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_orders_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_orders_table_id_fkey"
            columns: ["table_id"]
            isOneToOne: false
            referencedRelation: "pos_tables"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_outlets: {
        Row: {
          active: boolean
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["outlet_kind"]
          name: string
          property_id: string
          tax_rate: number
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["outlet_kind"]
          name: string
          property_id: string
          tax_rate?: number
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["outlet_kind"]
          name?: string
          property_id?: string
          tax_rate?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "pos_outlets_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_payments: {
        Row: {
          amount: number
          folio_charge_id: string | null
          id: string
          method: Database["public"]["Enums"]["payment_method"]
          order_id: string
          received_at: string
          received_by: string | null
          reference: string | null
        }
        Insert: {
          amount: number
          folio_charge_id?: string | null
          id?: string
          method: Database["public"]["Enums"]["payment_method"]
          order_id: string
          received_at?: string
          received_by?: string | null
          reference?: string | null
        }
        Update: {
          amount?: number
          folio_charge_id?: string | null
          id?: string
          method?: Database["public"]["Enums"]["payment_method"]
          order_id?: string
          received_at?: string
          received_by?: string | null
          reference?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "pos_payments_folio_charge_id_fkey"
            columns: ["folio_charge_id"]
            isOneToOne: false
            referencedRelation: "reservation_charges"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_payments_order_id_fkey"
            columns: ["order_id"]
            isOneToOne: false
            referencedRelation: "pos_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      pos_tables: {
        Row: {
          id: string
          label: string
          outlet_id: string
          property_id: string
          seats: number
          status: Database["public"]["Enums"]["pos_table_status"]
        }
        Insert: {
          id?: string
          label: string
          outlet_id: string
          property_id: string
          seats?: number
          status?: Database["public"]["Enums"]["pos_table_status"]
        }
        Update: {
          id?: string
          label?: string
          outlet_id?: string
          property_id?: string
          seats?: number
          status?: Database["public"]["Enums"]["pos_table_status"]
        }
        Relationships: [
          {
            foreignKeyName: "pos_tables_outlet_id_fkey"
            columns: ["outlet_id"]
            isOneToOne: false
            referencedRelation: "pos_outlets"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "pos_tables_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      posting_rules: {
        Row: {
          account_id: string
          created_at: string
          id: string
          notes: string | null
          property_id: string
          rule_key: string
          updated_at: string
        }
        Insert: {
          account_id: string
          created_at?: string
          id?: string
          notes?: string | null
          property_id: string
          rule_key: string
          updated_at?: string
        }
        Update: {
          account_id?: string
          created_at?: string
          id?: string
          notes?: string | null
          property_id?: string
          rule_key?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "posting_rules_account_id_fkey"
            columns: ["account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "posting_rules_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      print_jobs: {
        Row: {
          completed_at: string | null
          content: string | null
          content_url: string | null
          copies: number
          created_at: string
          created_by: string | null
          error: string | null
          id: string
          job_type: string
          metadata: Json | null
          printer_id: string | null
          priority: number
          property_id: string
          started_at: string | null
          status: string
          title: string | null
        }
        Insert: {
          completed_at?: string | null
          content?: string | null
          content_url?: string | null
          copies?: number
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          job_type: string
          metadata?: Json | null
          printer_id?: string | null
          priority?: number
          property_id: string
          started_at?: string | null
          status?: string
          title?: string | null
        }
        Update: {
          completed_at?: string | null
          content?: string | null
          content_url?: string | null
          copies?: number
          created_at?: string
          created_by?: string | null
          error?: string | null
          id?: string
          job_type?: string
          metadata?: Json | null
          printer_id?: string | null
          priority?: number
          property_id?: string
          started_at?: string | null
          status?: string
          title?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "print_jobs_printer_id_fkey"
            columns: ["printer_id"]
            isOneToOne: false
            referencedRelation: "printers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "print_jobs_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      printer_routing_rules: {
        Row: {
          created_at: string
          id: string
          is_active: boolean
          job_type: string
          printer_id: string
          priority: number
          property_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          is_active?: boolean
          job_type: string
          printer_id: string
          priority?: number
          property_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          is_active?: boolean
          job_type?: string
          printer_id?: string
          priority?: number
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "printer_routing_rules_printer_id_fkey"
            columns: ["printer_id"]
            isOneToOne: false
            referencedRelation: "printers"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "printer_routing_rules_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      printers: {
        Row: {
          config: Json | null
          created_at: string
          id: string
          is_default: boolean
          kind: string
          last_seen_at: string | null
          model: string | null
          name: string
          printnode_id: string | null
          property_id: string
          protocol: string | null
          status: string | null
          updated_at: string
        }
        Insert: {
          config?: Json | null
          created_at?: string
          id?: string
          is_default?: boolean
          kind: string
          last_seen_at?: string | null
          model?: string | null
          name: string
          printnode_id?: string | null
          property_id: string
          protocol?: string | null
          status?: string | null
          updated_at?: string
        }
        Update: {
          config?: Json | null
          created_at?: string
          id?: string
          is_default?: boolean
          kind?: string
          last_seen_at?: string | null
          model?: string | null
          name?: string
          printnode_id?: string | null
          property_id?: string
          protocol?: string | null
          status?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "printers_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      profiles: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          avatar_url: string | null
          created_at: string
          default_property_id: string | null
          full_name: string | null
          id: string
          phone: string | null
          status: Database["public"]["Enums"]["profile_status"]
          updated_at: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          avatar_url?: string | null
          created_at?: string
          default_property_id?: string | null
          full_name?: string | null
          id: string
          phone?: string | null
          status?: Database["public"]["Enums"]["profile_status"]
          updated_at?: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          avatar_url?: string | null
          created_at?: string
          default_property_id?: string | null
          full_name?: string | null
          id?: string
          phone?: string | null
          status?: Database["public"]["Enums"]["profile_status"]
          updated_at?: string
        }
        Relationships: []
      }
      properties: {
        Row: {
          active: boolean
          address: string | null
          base_currency: string
          code: string
          created_at: string
          currency: string
          email: string | null
          id: string
          is_public: boolean
          logo_url: string | null
          name: string
          phone: string | null
          slug: string | null
          timezone: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          address?: string | null
          base_currency?: string
          code: string
          created_at?: string
          currency?: string
          email?: string | null
          id?: string
          is_public?: boolean
          logo_url?: string | null
          name: string
          phone?: string | null
          slug?: string | null
          timezone?: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          address?: string | null
          base_currency?: string
          code?: string
          created_at?: string
          currency?: string
          email?: string | null
          id?: string
          is_public?: boolean
          logo_url?: string | null
          name?: string
          phone?: string | null
          slug?: string | null
          timezone?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "properties_base_currency_fkey"
            columns: ["base_currency"]
            isOneToOne: false
            referencedRelation: "currencies"
            referencedColumns: ["code"]
          },
        ]
      }
      purchase_order_lines: {
        Row: {
          id: string
          item_id: string
          po_id: string
          quantity: number
          received_qty: number
          unit_cost: number
        }
        Insert: {
          id?: string
          item_id: string
          po_id: string
          quantity: number
          received_qty?: number
          unit_cost?: number
        }
        Update: {
          id?: string
          item_id?: string
          po_id?: string
          quantity?: number
          received_qty?: number
          unit_cost?: number
        }
        Relationships: [
          {
            foreignKeyName: "purchase_order_lines_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_order_lines_po_id_fkey"
            columns: ["po_id"]
            isOneToOne: false
            referencedRelation: "purchase_orders"
            referencedColumns: ["id"]
          },
        ]
      }
      purchase_orders: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          expected_at: string | null
          id: string
          location_id: string | null
          notes: string | null
          ordered_at: string | null
          property_id: string
          received_at: string | null
          status: Database["public"]["Enums"]["po_status"]
          supplier_id: string | null
          total: number
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          expected_at?: string | null
          id?: string
          location_id?: string | null
          notes?: string | null
          ordered_at?: string | null
          property_id: string
          received_at?: string | null
          status?: Database["public"]["Enums"]["po_status"]
          supplier_id?: string | null
          total?: number
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          expected_at?: string | null
          id?: string
          location_id?: string | null
          notes?: string | null
          ordered_at?: string | null
          property_id?: string
          received_at?: string | null
          status?: Database["public"]["Enums"]["po_status"]
          supplier_id?: string | null
          total?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "purchase_orders_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "stock_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "purchase_orders_supplier_id_fkey"
            columns: ["supplier_id"]
            isOneToOne: false
            referencedRelation: "suppliers"
            referencedColumns: ["id"]
          },
        ]
      }
      rate_plans: {
        Row: {
          created_at: string
          end_date: string
          id: string
          min_stay: number
          name: string
          property_id: string
          rate: number
          room_type_id: string
          start_date: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          end_date: string
          id?: string
          min_stay?: number
          name: string
          property_id: string
          rate: number
          room_type_id: string
          start_date: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          end_date?: string
          id?: string
          min_stay?: number
          name?: string
          property_id?: string
          rate?: number
          room_type_id?: string
          start_date?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rate_plans_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rate_plans_room_type_id_fkey"
            columns: ["room_type_id"]
            isOneToOne: false
            referencedRelation: "room_types"
            referencedColumns: ["id"]
          },
        ]
      }
      recycle_bin: {
        Row: {
          created_at: string
          deleted_at: string
          deleted_by: string | null
          id: string
          label: string | null
          property_id: string | null
          purged_at: string | null
          restored_at: string | null
          snapshot: Json
          source_id: string
          source_table: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          deleted_at?: string
          deleted_by?: string | null
          id?: string
          label?: string | null
          property_id?: string | null
          purged_at?: string | null
          restored_at?: string | null
          snapshot: Json
          source_id: string
          source_table: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          deleted_at?: string
          deleted_by?: string | null
          id?: string
          label?: string | null
          property_id?: string | null
          purged_at?: string | null
          restored_at?: string | null
          snapshot?: Json
          source_id?: string
          source_table?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recycle_bin_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      reservation_charges: {
        Row: {
          amount: number
          description: string
          id: string
          posted_at: string
          posted_by: string | null
          reservation_id: string
        }
        Insert: {
          amount: number
          description: string
          id?: string
          posted_at?: string
          posted_by?: string | null
          reservation_id: string
        }
        Update: {
          amount?: number
          description?: string
          id?: string
          posted_at?: string
          posted_by?: string | null
          reservation_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "reservation_charges_reservation_id_fkey"
            columns: ["reservation_id"]
            isOneToOne: false
            referencedRelation: "reservations"
            referencedColumns: ["id"]
          },
        ]
      }
      reservations: {
        Row: {
          adults: number
          check_in: string
          check_out: string
          checked_in_at: string | null
          checked_out_at: string | null
          children: number
          code: string
          confirmation_code: string | null
          confirmation_email: string | null
          created_at: string
          created_by: string | null
          external_ref: string | null
          guest_id: string
          id: string
          notes: string | null
          property_id: string
          rate_total: number
          room_id: string | null
          room_type_id: string
          source: string | null
          status: Database["public"]["Enums"]["reservation_status"]
          updated_at: string
        }
        Insert: {
          adults?: number
          check_in: string
          check_out: string
          checked_in_at?: string | null
          checked_out_at?: string | null
          children?: number
          code: string
          confirmation_code?: string | null
          confirmation_email?: string | null
          created_at?: string
          created_by?: string | null
          external_ref?: string | null
          guest_id: string
          id?: string
          notes?: string | null
          property_id: string
          rate_total?: number
          room_id?: string | null
          room_type_id: string
          source?: string | null
          status?: Database["public"]["Enums"]["reservation_status"]
          updated_at?: string
        }
        Update: {
          adults?: number
          check_in?: string
          check_out?: string
          checked_in_at?: string | null
          checked_out_at?: string | null
          children?: number
          code?: string
          confirmation_code?: string | null
          confirmation_email?: string | null
          created_at?: string
          created_by?: string | null
          external_ref?: string | null
          guest_id?: string
          id?: string
          notes?: string | null
          property_id?: string
          rate_total?: number
          room_id?: string | null
          room_type_id?: string
          source?: string | null
          status?: Database["public"]["Enums"]["reservation_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reservations_guest_id_fkey"
            columns: ["guest_id"]
            isOneToOne: false
            referencedRelation: "guests"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_room_id_fkey"
            columns: ["room_id"]
            isOneToOne: false
            referencedRelation: "rooms"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reservations_room_type_id_fkey"
            columns: ["room_type_id"]
            isOneToOne: false
            referencedRelation: "room_types"
            referencedColumns: ["id"]
          },
        ]
      }
      role_permissions: {
        Row: {
          action: string
          allowed: boolean
          created_at: string
          custom_role_id: string | null
          id: string
          module: string
          property_id: string | null
          role: Database["public"]["Enums"]["app_role"] | null
        }
        Insert: {
          action: string
          allowed?: boolean
          created_at?: string
          custom_role_id?: string | null
          id?: string
          module: string
          property_id?: string | null
          role?: Database["public"]["Enums"]["app_role"] | null
        }
        Update: {
          action?: string
          allowed?: boolean
          created_at?: string
          custom_role_id?: string | null
          id?: string
          module?: string
          property_id?: string | null
          role?: Database["public"]["Enums"]["app_role"] | null
        }
        Relationships: [
          {
            foreignKeyName: "role_permissions_custom_role_id_fkey"
            columns: ["custom_role_id"]
            isOneToOne: false
            referencedRelation: "custom_roles"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "role_permissions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      room_types: {
        Row: {
          amenities: Json
          base_occupancy: number
          base_rate: number
          code: string
          created_at: string
          description: string | null
          id: string
          is_public: boolean
          max_occupancy: number
          name: string
          property_id: string
          updated_at: string
        }
        Insert: {
          amenities?: Json
          base_occupancy?: number
          base_rate?: number
          code: string
          created_at?: string
          description?: string | null
          id?: string
          is_public?: boolean
          max_occupancy?: number
          name: string
          property_id: string
          updated_at?: string
        }
        Update: {
          amenities?: Json
          base_occupancy?: number
          base_rate?: number
          code?: string
          created_at?: string
          description?: string | null
          id?: string
          is_public?: boolean
          max_occupancy?: number
          name?: string
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "room_types_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      rooms: {
        Row: {
          created_at: string
          floor: string | null
          housekeeping_status: Database["public"]["Enums"]["hk_status"]
          id: string
          notes: string | null
          number: string
          property_id: string
          room_type_id: string
          status: Database["public"]["Enums"]["room_status"]
          updated_at: string
        }
        Insert: {
          created_at?: string
          floor?: string | null
          housekeeping_status?: Database["public"]["Enums"]["hk_status"]
          id?: string
          notes?: string | null
          number: string
          property_id: string
          room_type_id: string
          status?: Database["public"]["Enums"]["room_status"]
          updated_at?: string
        }
        Update: {
          created_at?: string
          floor?: string | null
          housekeeping_status?: Database["public"]["Enums"]["hk_status"]
          id?: string
          notes?: string | null
          number?: string
          property_id?: string
          room_type_id?: string
          status?: Database["public"]["Enums"]["room_status"]
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "rooms_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "rooms_room_type_id_fkey"
            columns: ["room_type_id"]
            isOneToOne: false
            referencedRelation: "room_types"
            referencedColumns: ["id"]
          },
        ]
      }
      security_events: {
        Row: {
          created_at: string
          event_type: string
          geo_city: string | null
          geo_country: string | null
          id: string
          ip: unknown
          metadata: Json | null
          notes: string | null
          property_id: string | null
          resolved_at: string | null
          resolved_by: string | null
          severity: string
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          created_at?: string
          event_type: string
          geo_city?: string | null
          geo_country?: string | null
          id?: string
          ip?: unknown
          metadata?: Json | null
          notes?: string | null
          property_id?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          created_at?: string
          event_type?: string
          geo_city?: string | null
          geo_country?: string | null
          id?: string
          ip?: unknown
          metadata?: Json | null
          notes?: string | null
          property_id?: string | null
          resolved_at?: string | null
          resolved_by?: string | null
          severity?: string
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "security_events_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      security_settings: {
        Row: {
          allow_concurrent_sessions: boolean
          created_at: string
          id: string
          lockout_duration_minutes: number
          max_failed_attempts: number
          mfa_required: boolean
          notify_on_critical: boolean
          property_id: string | null
          session_max_age_hours: number
          updated_at: string
        }
        Insert: {
          allow_concurrent_sessions?: boolean
          created_at?: string
          id?: string
          lockout_duration_minutes?: number
          max_failed_attempts?: number
          mfa_required?: boolean
          notify_on_critical?: boolean
          property_id?: string | null
          session_max_age_hours?: number
          updated_at?: string
        }
        Update: {
          allow_concurrent_sessions?: boolean
          created_at?: string
          id?: string
          lockout_duration_minutes?: number
          max_failed_attempts?: number
          mfa_required?: boolean
          notify_on_critical?: boolean
          property_id?: string | null
          session_max_age_hours?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "security_settings_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: true
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_adjustment_lines: {
        Row: {
          adjustment_id: string
          delta: number
          id: string
          item_id: string
        }
        Insert: {
          adjustment_id: string
          delta: number
          id?: string
          item_id: string
        }
        Update: {
          adjustment_id?: string
          delta?: number
          id?: string
          item_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_adjustment_lines_adjustment_id_fkey"
            columns: ["adjustment_id"]
            isOneToOne: false
            referencedRelation: "stock_adjustments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_adjustment_lines_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_adjustments: {
        Row: {
          adjusted_at: string | null
          code: string
          created_at: string
          created_by: string | null
          id: string
          location_id: string
          notes: string | null
          property_id: string
          reason: string
          updated_at: string
        }
        Insert: {
          adjusted_at?: string | null
          code: string
          created_at?: string
          created_by?: string | null
          id?: string
          location_id: string
          notes?: string | null
          property_id: string
          reason: string
          updated_at?: string
        }
        Update: {
          adjusted_at?: string | null
          code?: string
          created_at?: string
          created_by?: string | null
          id?: string
          location_id?: string
          notes?: string | null
          property_id?: string
          reason?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_adjustments_location_id_fkey"
            columns: ["location_id"]
            isOneToOne: false
            referencedRelation: "stock_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_adjustments_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_locations: {
        Row: {
          created_at: string
          id: string
          kind: Database["public"]["Enums"]["location_kind"]
          name: string
          property_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["location_kind"]
          name: string
          property_id: string
        }
        Update: {
          created_at?: string
          id?: string
          kind?: Database["public"]["Enums"]["location_kind"]
          name?: string
          property_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_locations_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_transfer_lines: {
        Row: {
          id: string
          item_id: string
          quantity: number
          transfer_id: string
        }
        Insert: {
          id?: string
          item_id: string
          quantity: number
          transfer_id: string
        }
        Update: {
          id?: string
          item_id?: string
          quantity?: number
          transfer_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_transfer_lines_item_id_fkey"
            columns: ["item_id"]
            isOneToOne: false
            referencedRelation: "inventory_items"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfer_lines_transfer_id_fkey"
            columns: ["transfer_id"]
            isOneToOne: false
            referencedRelation: "stock_transfers"
            referencedColumns: ["id"]
          },
        ]
      }
      stock_transfers: {
        Row: {
          code: string
          created_at: string
          created_by: string | null
          from_location_id: string
          id: string
          notes: string | null
          property_id: string
          status: Database["public"]["Enums"]["transfer_status"]
          to_location_id: string
          transferred_at: string | null
          updated_at: string
        }
        Insert: {
          code: string
          created_at?: string
          created_by?: string | null
          from_location_id: string
          id?: string
          notes?: string | null
          property_id: string
          status?: Database["public"]["Enums"]["transfer_status"]
          to_location_id: string
          transferred_at?: string | null
          updated_at?: string
        }
        Update: {
          code?: string
          created_at?: string
          created_by?: string | null
          from_location_id?: string
          id?: string
          notes?: string | null
          property_id?: string
          status?: Database["public"]["Enums"]["transfer_status"]
          to_location_id?: string
          transferred_at?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stock_transfers_from_location_id_fkey"
            columns: ["from_location_id"]
            isOneToOne: false
            referencedRelation: "stock_locations"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfers_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stock_transfers_to_location_id_fkey"
            columns: ["to_location_id"]
            isOneToOne: false
            referencedRelation: "stock_locations"
            referencedColumns: ["id"]
          },
        ]
      }
      suppliers: {
        Row: {
          active: boolean
          address: string | null
          contact_name: string | null
          created_at: string
          email: string | null
          id: string
          name: string
          payment_terms: string | null
          phone: string | null
          property_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          address?: string | null
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name: string
          payment_terms?: string | null
          phone?: string | null
          property_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          address?: string | null
          contact_name?: string | null
          created_at?: string
          email?: string | null
          id?: string
          name?: string
          payment_terms?: string | null
          phone?: string | null
          property_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "suppliers_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      system_settings: {
        Row: {
          app_name: string
          app_short_name: string | null
          created_at: string
          default_currency: string
          favicon_url: string | null
          fx_last_error: string | null
          fx_last_status: string | null
          fx_last_synced_at: string | null
          fx_provider: string
          fx_refresh_interval_minutes: number
          id: boolean
          logo_dark_url: string | null
          logo_url: string | null
          primary_color: string | null
          support_email: string | null
          support_phone: string | null
          tagline: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          app_name?: string
          app_short_name?: string | null
          created_at?: string
          default_currency?: string
          favicon_url?: string | null
          fx_last_error?: string | null
          fx_last_status?: string | null
          fx_last_synced_at?: string | null
          fx_provider?: string
          fx_refresh_interval_minutes?: number
          id?: boolean
          logo_dark_url?: string | null
          logo_url?: string | null
          primary_color?: string | null
          support_email?: string | null
          support_phone?: string | null
          tagline?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          app_name?: string
          app_short_name?: string | null
          created_at?: string
          default_currency?: string
          favicon_url?: string | null
          fx_last_error?: string | null
          fx_last_status?: string | null
          fx_last_synced_at?: string | null
          fx_provider?: string
          fx_refresh_interval_minutes?: number
          id?: boolean
          logo_dark_url?: string | null
          logo_url?: string | null
          primary_color?: string | null
          support_email?: string | null
          support_phone?: string | null
          tagline?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "system_settings_default_currency_fkey"
            columns: ["default_currency"]
            isOneToOne: false
            referencedRelation: "currencies"
            referencedColumns: ["code"]
          },
        ]
      }
      tax_codes: {
        Row: {
          code: string
          created_at: string
          id: string
          is_active: boolean
          name: string
          payable_account_id: string | null
          property_id: string
          rate: number
        }
        Insert: {
          code: string
          created_at?: string
          id?: string
          is_active?: boolean
          name: string
          payable_account_id?: string | null
          property_id: string
          rate?: number
        }
        Update: {
          code?: string
          created_at?: string
          id?: string
          is_active?: boolean
          name?: string
          payable_account_id?: string | null
          property_id?: string
          rate?: number
        }
        Relationships: [
          {
            foreignKeyName: "tax_codes_payable_account_id_fkey"
            columns: ["payable_account_id"]
            isOneToOne: false
            referencedRelation: "accounts"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tax_codes_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      user_roles: {
        Row: {
          created_at: string
          id: string
          property_id: string | null
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          property_id?: string | null
          role: Database["public"]["Enums"]["app_role"]
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          property_id?: string | null
          role?: Database["public"]["Enums"]["app_role"]
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_roles_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      user_sessions: {
        Row: {
          browser: string | null
          device_fingerprint: string | null
          id: string
          ip: string | null
          last_seen_at: string
          os: string | null
          property_id: string | null
          session_key: string
          started_at: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          browser?: string | null
          device_fingerprint?: string | null
          id?: string
          ip?: string | null
          last_seen_at?: string
          os?: string | null
          property_id?: string | null
          session_key: string
          started_at?: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          browser?: string | null
          device_fingerprint?: string | null
          id?: string
          ip?: string | null
          last_seen_at?: string
          os?: string | null
          property_id?: string | null
          session_key?: string
          started_at?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "user_sessions_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      ap_aging: {
        Row: {
          amount_paid: number | null
          balance: number | null
          bucket: string | null
          code: string | null
          days_overdue: number | null
          due_date: string | null
          id: string | null
          property_id: string | null
          supplier_name: string | null
          total: number | null
        }
        Insert: {
          amount_paid?: number | null
          balance?: never
          bucket?: never
          code?: string | null
          days_overdue?: never
          due_date?: string | null
          id?: string | null
          property_id?: string | null
          supplier_name?: string | null
          total?: number | null
        }
        Update: {
          amount_paid?: number | null
          balance?: never
          bucket?: never
          code?: string | null
          days_overdue?: never
          due_date?: string | null
          id?: string | null
          property_id?: string | null
          supplier_name?: string | null
          total?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ap_bills_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
      ar_aging: {
        Row: {
          amount_paid: number | null
          balance: number | null
          bill_to_name: string | null
          bucket: string | null
          code: string | null
          days_overdue: number | null
          due_date: string | null
          id: string | null
          property_id: string | null
          total: number | null
        }
        Insert: {
          amount_paid?: number | null
          balance?: never
          bill_to_name?: string | null
          bucket?: never
          code?: string | null
          days_overdue?: never
          due_date?: string | null
          id?: string | null
          property_id?: string | null
          total?: number | null
        }
        Update: {
          amount_paid?: number | null
          balance?: never
          bill_to_name?: string | null
          bucket?: never
          code?: string | null
          days_overdue?: never
          due_date?: string | null
          id?: string | null
          property_id?: string | null
          total?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "ar_invoices_property_id_fkey"
            columns: ["property_id"]
            isOneToOne: false
            referencedRelation: "properties"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      accounting_daily_summary: {
        Args: { _from: string; _property_id: string; _to: string }
        Returns: {
          account_code: string
          account_name: string
          account_type: Database["public"]["Enums"]["account_type"]
          credit_base: number
          debit_base: number
          entries_count: number
          entry_date: string
        }[]
      }
      admin_log: {
        Args: {
          _action: string
          _after: Json
          _before: Json
          _entity_id: string
          _entity_type: string
          _memo?: string
          _property_id: string
        }
        Returns: string
      }
      apply_adjustment: { Args: { _id: string }; Returns: undefined }
      apply_stock_delta: {
        Args: {
          _delta: number
          _item_id: string
          _location_id: string
          _property_id: string
        }
        Returns: undefined
      }
      create_ar_invoice: {
        Args: {
          _currency: string
          _customer_id: string
          _due_date: string
          _issue_date: string
          _lines: Json
          _notes: string | null
          _property_id: string
        }
        Returns: string
      }
      audit_capture: {
        Args: {
          _action: string
          _after: Json
          _before: Json
          _browser: string
          _entity_id: string
          _entity_type: string
          _fingerprint: string
          _ip: string
          _memo: string
          _os: string
          _property_id: string
          _remarks: string
          _session_id: string
          _success: boolean
          _user_agent: string
        }
        Returns: string
      }
      audit_purge: {
        Args: { _before: string; _property_id: string }
        Returns: number
      }
      booking_cancel: {
        Args: { _confirmation_code: string; _email: string }
        Returns: boolean
      }
      booking_create: {
        Args: {
          _address: string
          _adults: number
          _check_in: string
          _check_out: string
          _children: number
          _email: string
          _external_ref?: string
          _first_name: string
          _last_name: string
          _notes?: string
          _phone: string
          _property_id: string
          _room_type_id: string
          _source?: string
        }
        Returns: {
          confirmation_code: string
          reservation_id: string
        }[]
      }
      booking_lookup: {
        Args: { _confirmation_code: string; _email: string }
        Returns: {
          adults: number
          check_in: string
          check_out: string
          children: number
          code: string
          confirmation_code: string
          guest_email: string
          guest_first_name: string
          guest_last_name: string
          guest_phone: string
          id: string
          property_id: string
          property_name: string
          rate_total: number
          room_type_id: string
          room_type_name: string
          status: Database["public"]["Enums"]["reservation_status"]
        }[]
      }
      booking_modify: {
        Args: {
          _adults: number
          _check_in: string
          _check_out: string
          _children: number
          _confirmation_code: string
          _email: string
        }
        Returns: boolean
      }
      booking_search_availability: {
        Args: {
          _check_in: string
          _check_out: string
          _guests?: number
          _property_id: string
        }
        Returns: {
          amenities: Json
          available_rooms: number
          base_rate: number
          best_rate: number
          description: string
          max_occupancy: number
          room_type_id: string
          room_type_name: string
        }[]
      }
      can_access_property: {
        Args: { _property_id: string; _user_id: string }
        Returns: boolean
      }
      channel_import_queue: { Args: { _queue_id: string }; Returns: string }
      close_pos_order: {
        Args: {
          _amount: number
          _method: Database["public"]["Enums"]["payment_method"]
          _order_id: string
          _post_to_folio: boolean
          _reference: string
          _reservation_id: string
        }
        Returns: string
      }
      esl_redeem_pairing_code: {
        Args: {
          _address: string
          _code: string
          _model: string
          _name: string
          _vendor: string
        }
        Returns: string
      }
      exec_analytics_kpis: {
        Args: { _from: string; _property_id: string; _to: string }
        Returns: {
          adr: number
          avg_los: number
          cancellation_rate: number
          cancelled_count: number
          days: number
          nights_sold: number
          occupancy_pct: number
          pos_revenue: number
          reservations_count: number
          revenue: number
          revpar: number
          room_count: number
          room_revenue: number
        }[]
      }
      exec_analytics_revenue_by_day: {
        Args: { _from: string; _property_id: string; _to: string }
        Returns: {
          day: string
          pos_revenue: number
          room_revenue: number
          total: number
        }[]
      }
      exec_analytics_revenue_by_source: {
        Args: { _from: string; _property_id: string; _to: string }
        Returns: {
          reservations: number
          revenue: number
          source: string
        }[]
      }
      exec_analytics_top_room_types: {
        Args: { _from: string; _property_id: string; _to: string }
        Returns: {
          nights: number
          revenue: number
          room_type: string
        }[]
      }
      execute_transfer: { Args: { _id: string }; Returns: undefined }
      fire_kot: { Args: { _order_id: string }; Returns: string }
      fx_convert: {
        Args: {
          _amount: number
          _from: string
          _on_date: string
          _property_id: string
          _to: string
        }
        Returns: number
      }
      get_brand_settings: {
        Args: never
        Returns: {
          app_name: string
          app_short_name: string
          favicon_url: string
          logo_dark_url: string
          logo_url: string
          primary_color: string
          support_email: string
          support_phone: string
          tagline: string
        }[]
      }
      has_any_role: {
        Args: {
          _property_id?: string
          _roles: Database["public"]["Enums"]["app_role"][]
          _user_id: string
        }
        Returns: boolean
      }
      has_role: {
        Args: {
          _property_id?: string
          _role: Database["public"]["Enums"]["app_role"]
          _user_id: string
        }
        Returns: boolean
      }
      is_security_admin: { Args: { _user_id: string }; Returns: boolean }
      notify: {
        Args: {
          _body: string
          _category: string
          _link: string
          _metadata?: Json
          _priority: string
          _property_id: string
          _title: string
          _user_id: string
        }
        Returns: string
      }
      post_ap_bill: { Args: { _id: string }; Returns: string }
      post_ap_payment: { Args: { _id: string }; Returns: string }
      post_ar_invoice: { Args: { _id: string }; Returns: string }
      post_journal: {
        Args: {
          _currency: string
          _entry_date: string
          _lines: Json
          _memo: string
          _property_id: string
          _source: Database["public"]["Enums"]["journal_source"]
          _source_ref: string
        }
        Returns: string
      }
      post_payment: { Args: { _pay_id: string }; Returns: string }
      post_pos_order_close: { Args: { _order_id: string }; Returns: string }
      post_reservation_checkout: { Args: { _res_id: string }; Returns: string }
      receive_purchase_order: { Args: { _po_id: string }; Returns: undefined }
      report_balance_sheet: {
        Args: { _as_of: string; _property_id: string }
        Returns: {
          account_id: string
          balance: number
          code: string
          name: string
          type: Database["public"]["Enums"]["account_type"]
        }[]
      }
      report_profit_loss: {
        Args: { _from: string; _property_id: string; _to: string }
        Returns: {
          account_id: string
          amount: number
          code: string
          name: string
          type: Database["public"]["Enums"]["account_type"]
        }[]
      }
      report_trial_balance: {
        Args: { _from: string; _property_id: string; _to: string }
        Returns: {
          account_id: string
          balance: number
          code: string
          credit_total: number
          debit_total: number
          name: string
          type: Database["public"]["Enums"]["account_type"]
        }[]
      }
      resolve_account: {
        Args: {
          _fallback_system_key: string
          _property_id: string
          _rule_key: string
        }
        Returns: string
      }
      reverse_ar_invoice: { Args: { _id: string; _reason: string }; Returns: string }
      run_night_audit: {
        Args: {
          _business_date: string
          _lock_period?: boolean
          _property_id: string
        }
        Returns: string
      }
      seed_default_accounts: {
        Args: { _property_id: string }
        Returns: undefined
      }
      short_code: { Args: { prefix: string }; Returns: string }
    }
    Enums: {
      account_type: "asset" | "liability" | "equity" | "revenue" | "expense"
      ap_status: "draft" | "open" | "paid" | "void"
      app_role:
        | "super_admin"
        | "hotel_owner"
        | "general_manager"
        | "front_desk"
        | "reservations"
        | "cashier"
        | "accountant"
        | "housekeeping_supervisor"
        | "housekeeping"
        | "guest"
        | "manager"
        | "restaurant_manager"
        | "waiter"
        | "kitchen"
        | "storekeeper"
        | "auditor"
        | "guest_relations"
        | "security"
        | "maintenance"
        | "hr"
      ar_status: "draft" | "sent" | "paid" | "void"
      channel_queue_status: "pending" | "imported" | "failed" | "ignored"
      channel_sync_direction:
        | "push_ari"
        | "pull_reservations"
        | "webhook_inbound"
      channel_sync_status: "idle" | "syncing" | "success" | "failed"
      channel_type: "booking_com" | "expedia" | "airbnb"
      hk_status: "clean" | "dirty" | "inspected" | "maintenance"
      journal_source:
        | "manual"
        | "folio"
        | "pos"
        | "ap"
        | "ar"
        | "payment"
        | "night_audit"
        | "fx"
        | "external_sync"
      location_kind: "store" | "bar" | "kitchen" | "housekeeping" | "other"
      night_audit_status: "pending" | "completed" | "failed"
      outlet_kind: "restaurant" | "bar" | "room_service" | "other"
      payment_method:
        | "cash"
        | "card"
        | "bank_transfer"
        | "mobile_money"
        | "wallet"
        | "other"
      period_status: "open" | "locked" | "closed"
      po_status: "draft" | "sent" | "partial" | "received" | "cancelled"
      pos_order_status: "open" | "sent" | "served" | "closed" | "void"
      pos_table_status: "free" | "occupied" | "reserved"
      profile_status: "pending" | "active" | "disabled"
      reservation_status:
        | "confirmed"
        | "checked_in"
        | "checked_out"
        | "cancelled"
        | "no_show"
      room_status: "available" | "occupied" | "out_of_order" | "blocked"
      transfer_status: "draft" | "completed" | "cancelled"
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
        Row: infer R
      }
      ? R
      : never
    : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Insert: infer I
      }
      ? I
      : never
    : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
    ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
        Update: infer U
      }
      ? U
      : never
    : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
    ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
    : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {
      account_type: ["asset", "liability", "equity", "revenue", "expense"],
      ap_status: ["draft", "open", "paid", "void"],
      app_role: [
        "super_admin",
        "hotel_owner",
        "general_manager",
        "front_desk",
        "reservations",
        "cashier",
        "accountant",
        "housekeeping_supervisor",
        "housekeeping",
        "guest",
        "manager",
        "restaurant_manager",
        "waiter",
        "kitchen",
        "storekeeper",
        "auditor",
        "guest_relations",
        "security",
        "maintenance",
        "hr",
      ],
      ar_status: ["draft", "sent", "paid", "void"],
      channel_queue_status: ["pending", "imported", "failed", "ignored"],
      channel_sync_direction: [
        "push_ari",
        "pull_reservations",
        "webhook_inbound",
      ],
      channel_sync_status: ["idle", "syncing", "success", "failed"],
      channel_type: ["booking_com", "expedia", "airbnb"],
      hk_status: ["clean", "dirty", "inspected", "maintenance"],
      journal_source: [
        "manual",
        "folio",
        "pos",
        "ap",
        "ar",
        "payment",
        "night_audit",
        "fx",
        "external_sync",
      ],
      location_kind: ["store", "bar", "kitchen", "housekeeping", "other"],
      night_audit_status: ["pending", "completed", "failed"],
      outlet_kind: ["restaurant", "bar", "room_service", "other"],
      payment_method: [
        "cash",
        "card",
        "bank_transfer",
        "mobile_money",
        "wallet",
        "other",
      ],
      period_status: ["open", "locked", "closed"],
      po_status: ["draft", "sent", "partial", "received", "cancelled"],
      pos_order_status: ["open", "sent", "served", "closed", "void"],
      pos_table_status: ["free", "occupied", "reserved"],
      profile_status: ["pending", "active", "disabled"],
      reservation_status: [
        "confirmed",
        "checked_in",
        "checked_out",
        "cancelled",
        "no_show",
      ],
      room_status: ["available", "occupied", "out_of_order", "blocked"],
      transfer_status: ["draft", "completed", "cancelled"],
    },
  },
} as const
