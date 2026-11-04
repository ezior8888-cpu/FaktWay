// Wygenerowane 20.10.2026 z produkcyjnego schematu (postgres-meta na db-1,
// schematy graphql_public i public; PostgREST v14.6) po migracjach do 00154
// (m.in. 00153 data rozpoczęcia działalności, 00154 faktury cykliczne). Nie edytuj ręcznie: przy nowej migracji wygeneruj ponownie.
export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  __InternalSupabase: {
    PostgrestVersion: "14.6"
  }
  graphql_public: {
    Tables: {
      [_ in never]: never
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      graphql: {
        Args: {
          extensions?: Json
          operationName?: string
          query?: string
          variables?: Json
        }
        Returns: Json
      }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
  public: {
    Tables: {
      accountant_access: {
        Row: {
          access_level: string | null
          accountant_email: string
          accountant_name: string
          created_at: string
          created_by_user_id: string | null
          expires_at: string
          granted_at: string | null
          id: string
          last_used_at: string | null
          revoked_at: string | null
          tenant_id: string
          token_hash: string
          use_count: number
        }
        Insert: {
          access_level?: string | null
          accountant_email: string
          accountant_name: string
          created_at?: string
          created_by_user_id?: string | null
          expires_at: string
          granted_at?: string | null
          id?: string
          last_used_at?: string | null
          revoked_at?: string | null
          tenant_id: string
          token_hash: string
          use_count?: number
        }
        Update: {
          access_level?: string | null
          accountant_email?: string
          accountant_name?: string
          created_at?: string
          created_by_user_id?: string | null
          expires_at?: string
          granted_at?: string | null
          id?: string
          last_used_at?: string | null
          revoked_at?: string | null
          tenant_id?: string
          token_hash?: string
          use_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "accountant_access_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accountant_access_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "accountant_access_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accountant_access_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      accountant_settings: {
        Row: {
          accountant_company: string | null
          accountant_email: string | null
          accountant_name: string | null
          cc_emails: string[] | null
          co_pilot_enabled: boolean
          created_at: string
          email_body_template: string | null
          email_subject_template: string | null
          id: string
          include_corrections: boolean
          include_issued_invoices: boolean
          include_received_invoices: boolean
          include_unpaid_only: boolean
          last_sent_at: string | null
          last_sent_period_end: string | null
          last_sent_period_start: string | null
          preferred_formats:
            | Database["public"]["Enums"]["export_format_enum"][]
            | null
          send_day_of_month: number
          tenant_id: string
          total_packages_sent: number
          updated_at: string
        }
        Insert: {
          accountant_company?: string | null
          accountant_email?: string | null
          accountant_name?: string | null
          cc_emails?: string[] | null
          co_pilot_enabled?: boolean
          created_at?: string
          email_body_template?: string | null
          email_subject_template?: string | null
          id?: string
          include_corrections?: boolean
          include_issued_invoices?: boolean
          include_received_invoices?: boolean
          include_unpaid_only?: boolean
          last_sent_at?: string | null
          last_sent_period_end?: string | null
          last_sent_period_start?: string | null
          preferred_formats?:
            | Database["public"]["Enums"]["export_format_enum"][]
            | null
          send_day_of_month?: number
          tenant_id: string
          total_packages_sent?: number
          updated_at?: string
        }
        Update: {
          accountant_company?: string | null
          accountant_email?: string | null
          accountant_name?: string | null
          cc_emails?: string[] | null
          co_pilot_enabled?: boolean
          created_at?: string
          email_body_template?: string | null
          email_subject_template?: string | null
          id?: string
          include_corrections?: boolean
          include_issued_invoices?: boolean
          include_received_invoices?: boolean
          include_unpaid_only?: boolean
          last_sent_at?: string | null
          last_sent_period_end?: string | null
          last_sent_period_start?: string | null
          preferred_formats?:
            | Database["public"]["Enums"]["export_format_enum"][]
            | null
          send_day_of_month?: number
          tenant_id?: string
          total_packages_sent?: number
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "accountant_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "accountant_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "accountant_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      admin_user_notes: {
        Row: {
          archived_at: string | null
          author_email: string
          author_user_id: string | null
          body: string
          created_at: string
          id: string
          updated_at: string
          user_id: string
        }
        Insert: {
          archived_at?: string | null
          author_email: string
          author_user_id?: string | null
          body: string
          created_at?: string
          id?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          archived_at?: string | null
          author_email?: string
          author_user_id?: string | null
          body?: string
          created_at?: string
          id?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: []
      }
      audit_logs: {
        Row: {
          action: string
          created_at: string
          details_json: Json | null
          entity_id: string | null
          entity_type: string | null
          id: string
          ip_address: unknown
          metadata: Json | null
          tenant_id: string | null
          user_agent: string | null
          user_id: string | null
        }
        Insert: {
          action: string
          created_at?: string
          details_json?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          ip_address?: unknown
          metadata?: Json | null
          tenant_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Update: {
          action?: string
          created_at?: string
          details_json?: Json | null
          entity_id?: string | null
          entity_type?: string | null
          id?: string
          ip_address?: unknown
          metadata?: Json | null
          tenant_id?: string | null
          user_agent?: string | null
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "audit_logs_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      backup_log: {
        Row: {
          checksum: string | null
          completed_at: string | null
          duration_ms: number | null
          error_message: string | null
          id: string
          kind: Database["public"]["Enums"]["backup_kind"]
          r2_key: string | null
          row_counts: Json | null
          size_bytes: number | null
          started_at: string
          status: Database["public"]["Enums"]["backup_status"]
        }
        Insert: {
          checksum?: string | null
          completed_at?: string | null
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          kind: Database["public"]["Enums"]["backup_kind"]
          r2_key?: string | null
          row_counts?: Json | null
          size_bytes?: number | null
          started_at?: string
          status?: Database["public"]["Enums"]["backup_status"]
        }
        Update: {
          checksum?: string | null
          completed_at?: string | null
          duration_ms?: number | null
          error_message?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["backup_kind"]
          r2_key?: string | null
          row_counts?: Json | null
          size_bytes?: number | null
          started_at?: string
          status?: Database["public"]["Enums"]["backup_status"]
        }
        Relationships: []
      }
      billing_invoice_counters: {
        Row: {
          last_number: number
          operator_tenant_id: string
          period: string
        }
        Insert: {
          last_number: number
          operator_tenant_id: string
          period: string
        }
        Update: {
          last_number?: number
          operator_tenant_id?: string
          period?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_invoice_counters_operator_tenant_id_fkey"
            columns: ["operator_tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "billing_invoice_counters_operator_tenant_id_fkey"
            columns: ["operator_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_invoice_counters_operator_tenant_id_fkey"
            columns: ["operator_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      billing_notifications: {
        Row: {
          entity_id: string
          error_message: string | null
          id: string
          kind: Database["public"]["Enums"]["billing_notification_kind_enum"]
          recipient_email: string
          resend_message_id: string | null
          sent_at: string
          status: string
          tenant_id: string
        }
        Insert: {
          entity_id: string
          error_message?: string | null
          id?: string
          kind: Database["public"]["Enums"]["billing_notification_kind_enum"]
          recipient_email: string
          resend_message_id?: string | null
          sent_at?: string
          status?: string
          tenant_id: string
        }
        Update: {
          entity_id?: string
          error_message?: string | null
          id?: string
          kind?: Database["public"]["Enums"]["billing_notification_kind_enum"]
          recipient_email?: string
          resend_message_id?: string | null
          sent_at?: string
          status?: string
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "billing_notifications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "billing_notifications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "billing_notifications_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      categorization_rules: {
        Row: {
          category_label: string
          created_at: string
          hit_count: number
          id: string
          kpir_column: Database["public"]["Enums"]["kpir_column"]
          last_used_at: string | null
          match_type: string
          match_value: string
          max_amount: number | null
          min_amount: number | null
          tenant_id: string
        }
        Insert: {
          category_label: string
          created_at?: string
          hit_count?: number
          id?: string
          kpir_column: Database["public"]["Enums"]["kpir_column"]
          last_used_at?: string | null
          match_type: string
          match_value: string
          max_amount?: number | null
          min_amount?: number | null
          tenant_id: string
        }
        Update: {
          category_label?: string
          created_at?: string
          hit_count?: number
          id?: string
          kpir_column?: Database["public"]["Enums"]["kpir_column"]
          last_used_at?: string | null
          match_type?: string
          match_value?: string
          max_amount?: number | null
          min_amount?: number | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "categorization_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "categorization_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "categorization_rules_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      contractors: {
        Row: {
          address: Json | null
          bank_accounts_validated: string[] | null
          created_at: string
          email: string | null
          id: string
          last_used_at: string | null
          last_validation_at: string | null
          last_validation_source:
            | Database["public"]["Enums"]["validation_source_enum"]
            | null
          late_payment_count: number
          manual_fields: string[]
          name: string
          nip: string
          payment_terms_days_avg: number | null
          phone: string | null
          reminder_excluded: boolean
          reminder_exclusion_reason: string | null
          tenant_id: string
          validation_warning: string | null
          vat_status: Database["public"]["Enums"]["vat_status_enum"] | null
        }
        Insert: {
          address?: Json | null
          bank_accounts_validated?: string[] | null
          created_at?: string
          email?: string | null
          id?: string
          last_used_at?: string | null
          last_validation_at?: string | null
          last_validation_source?:
            | Database["public"]["Enums"]["validation_source_enum"]
            | null
          late_payment_count?: number
          manual_fields?: string[]
          name: string
          nip: string
          payment_terms_days_avg?: number | null
          phone?: string | null
          reminder_excluded?: boolean
          reminder_exclusion_reason?: string | null
          tenant_id: string
          validation_warning?: string | null
          vat_status?: Database["public"]["Enums"]["vat_status_enum"] | null
        }
        Update: {
          address?: Json | null
          bank_accounts_validated?: string[] | null
          created_at?: string
          email?: string | null
          id?: string
          last_used_at?: string | null
          last_validation_at?: string | null
          last_validation_source?:
            | Database["public"]["Enums"]["validation_source_enum"]
            | null
          late_payment_count?: number
          manual_fields?: string[]
          name?: string
          nip?: string
          payment_terms_days_avg?: number | null
          phone?: string | null
          reminder_excluded?: boolean
          reminder_exclusion_reason?: string | null
          tenant_id?: string
          validation_warning?: string | null
          vat_status?: Database["public"]["Enums"]["vat_status_enum"] | null
        }
        Relationships: [
          {
            foreignKeyName: "contractors_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "contractors_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contractors_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      email_bounces: {
        Row: {
          bounce_type: Database["public"]["Enums"]["email_bounce_type_enum"]
          email: string
          id: string
          occurred_at: string
          raw_payload: Json | null
          reason: string | null
          resend_event_id: string | null
        }
        Insert: {
          bounce_type: Database["public"]["Enums"]["email_bounce_type_enum"]
          email: string
          id?: string
          occurred_at?: string
          raw_payload?: Json | null
          reason?: string | null
          resend_event_id?: string | null
        }
        Update: {
          bounce_type?: Database["public"]["Enums"]["email_bounce_type_enum"]
          email?: string
          id?: string
          occurred_at?: string
          raw_payload?: Json | null
          reason?: string | null
          resend_event_id?: string | null
        }
        Relationships: []
      }
      email_preferences: {
        Row: {
          category: Database["public"]["Enums"]["email_category_enum"]
          id: string
          reason: string | null
          source: string
          unsubscribed_at: string
          user_id: string
        }
        Insert: {
          category: Database["public"]["Enums"]["email_category_enum"]
          id?: string
          reason?: string | null
          source: string
          unsubscribed_at?: string
          user_id: string
        }
        Update: {
          category?: Database["public"]["Enums"]["email_category_enum"]
          id?: string
          reason?: string | null
          source?: string
          unsubscribed_at?: string
          user_id?: string
        }
        Relationships: []
      }
      error_translations: {
        Row: {
          created_at: string
          error_code: string
          error_xpath: string | null
          field_hint: string | null
          fix_suggestion: string | null
          id: string
          last_seen_at: string | null
          occurrence_count: number
          severity: string
          technical_description: string | null
          updated_at: string
          user_message_pl: string
        }
        Insert: {
          created_at?: string
          error_code: string
          error_xpath?: string | null
          field_hint?: string | null
          fix_suggestion?: string | null
          id?: string
          last_seen_at?: string | null
          occurrence_count?: number
          severity?: string
          technical_description?: string | null
          updated_at?: string
          user_message_pl: string
        }
        Update: {
          created_at?: string
          error_code?: string
          error_xpath?: string | null
          field_hint?: string | null
          fix_suggestion?: string | null
          id?: string
          last_seen_at?: string | null
          occurrence_count?: number
          severity?: string
          technical_description?: string | null
          updated_at?: string
          user_message_pl?: string
        }
        Relationships: []
      }
      expenses: {
        Row: {
          categorization_confidence: number | null
          categorization_method:
            | Database["public"]["Enums"]["categorization_method"]
            | null
          category_label: string | null
          created_at: string
          created_by: string | null
          document_number: string | null
          document_type: string
          gross_amount: number
          id: string
          is_deductible: boolean
          is_reviewed: boolean
          issue_date: string
          kpir_column: Database["public"]["Enums"]["kpir_column"] | null
          ksef_invoice_id: string | null
          net_amount: number
          notes: string | null
          ocr_extracted_data: Json | null
          ocr_job_id: string | null
          seller_address: string | null
          seller_name: string
          seller_nip: string | null
          source: Database["public"]["Enums"]["expense_source"]
          source_file_mime: string | null
          source_file_path: string | null
          tenant_id: string
          updated_at: string
          vat_amount: number
          vat_deductible_amount: number
          vat_rate: string | null
        }
        Insert: {
          categorization_confidence?: number | null
          categorization_method?:
            | Database["public"]["Enums"]["categorization_method"]
            | null
          category_label?: string | null
          created_at?: string
          created_by?: string | null
          document_number?: string | null
          document_type?: string
          gross_amount: number
          id?: string
          is_deductible?: boolean
          is_reviewed?: boolean
          issue_date: string
          kpir_column?: Database["public"]["Enums"]["kpir_column"] | null
          ksef_invoice_id?: string | null
          net_amount: number
          notes?: string | null
          ocr_extracted_data?: Json | null
          ocr_job_id?: string | null
          seller_address?: string | null
          seller_name: string
          seller_nip?: string | null
          source: Database["public"]["Enums"]["expense_source"]
          source_file_mime?: string | null
          source_file_path?: string | null
          tenant_id: string
          updated_at?: string
          vat_amount?: number
          vat_deductible_amount?: number
          vat_rate?: string | null
        }
        Update: {
          categorization_confidence?: number | null
          categorization_method?:
            | Database["public"]["Enums"]["categorization_method"]
            | null
          category_label?: string | null
          created_at?: string
          created_by?: string | null
          document_number?: string | null
          document_type?: string
          gross_amount?: number
          id?: string
          is_deductible?: boolean
          is_reviewed?: boolean
          issue_date?: string
          kpir_column?: Database["public"]["Enums"]["kpir_column"] | null
          ksef_invoice_id?: string | null
          net_amount?: number
          notes?: string | null
          ocr_extracted_data?: Json | null
          ocr_job_id?: string | null
          seller_address?: string | null
          seller_name?: string
          seller_nip?: string | null
          source?: Database["public"]["Enums"]["expense_source"]
          source_file_mime?: string | null
          source_file_path?: string | null
          tenant_id?: string
          updated_at?: string
          vat_amount?: number
          vat_deductible_amount?: number
          vat_rate?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "expenses_ksef_invoice_id_fkey"
            columns: ["ksef_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_ksef_invoice_id_fkey"
            columns: ["ksef_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices_overdue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_ksef_invoice_same_tenant_fk"
            columns: ["tenant_id", "ksef_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "expenses_ksef_invoice_same_tenant_fk"
            columns: ["tenant_id", "ksef_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices_overdue"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "expenses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "expenses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "expenses_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      export_files: {
        Row: {
          created_at: string
          download_count: number
          export_job_id: string
          file_hash: string | null
          filename: string
          format: Database["public"]["Enums"]["export_format_enum"]
          id: string
          last_downloaded_at: string | null
          last_downloaded_by: string | null
          mime_type: string
          r2_path: string
          size_bytes: number | null
          tenant_id: string
        }
        Insert: {
          created_at?: string
          download_count?: number
          export_job_id: string
          file_hash?: string | null
          filename: string
          format: Database["public"]["Enums"]["export_format_enum"]
          id?: string
          last_downloaded_at?: string | null
          last_downloaded_by?: string | null
          mime_type: string
          r2_path: string
          size_bytes?: number | null
          tenant_id: string
        }
        Update: {
          created_at?: string
          download_count?: number
          export_job_id?: string
          file_hash?: string | null
          filename?: string
          format?: Database["public"]["Enums"]["export_format_enum"]
          id?: string
          last_downloaded_at?: string | null
          last_downloaded_by?: string | null
          mime_type?: string
          r2_path?: string
          size_bytes?: number | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "export_files_export_job_id_fkey"
            columns: ["export_job_id"]
            isOneToOne: false
            referencedRelation: "export_jobs"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "export_files_last_downloaded_by_fkey"
            columns: ["last_downloaded_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "export_files_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "export_files_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "export_files_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      export_jobs: {
        Row: {
          completed_at: string | null
          created_at: string
          email_message_id: string | null
          emailed_at: string | null
          emailed_to: string | null
          error_details: Json | null
          error_message: string | null
          expires_at: string | null
          format: Database["public"]["Enums"]["export_format_enum"]
          id: string
          include_corrections: boolean
          include_issued: boolean
          include_received: boolean
          invoices_count: number
          period_end: string
          period_start: string
          progress_message: string | null
          started_at: string | null
          status: Database["public"]["Enums"]["export_status_enum"]
          tenant_id: string
          total_gross: number | null
          total_net: number | null
          total_vat: number | null
          trigger_source: Database["public"]["Enums"]["export_trigger_enum"]
          triggered_by: string | null
        }
        Insert: {
          completed_at?: string | null
          created_at?: string
          email_message_id?: string | null
          emailed_at?: string | null
          emailed_to?: string | null
          error_details?: Json | null
          error_message?: string | null
          expires_at?: string | null
          format: Database["public"]["Enums"]["export_format_enum"]
          id?: string
          include_corrections?: boolean
          include_issued?: boolean
          include_received?: boolean
          invoices_count?: number
          period_end: string
          period_start: string
          progress_message?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["export_status_enum"]
          tenant_id: string
          total_gross?: number | null
          total_net?: number | null
          total_vat?: number | null
          trigger_source?: Database["public"]["Enums"]["export_trigger_enum"]
          triggered_by?: string | null
        }
        Update: {
          completed_at?: string | null
          created_at?: string
          email_message_id?: string | null
          emailed_at?: string | null
          emailed_to?: string | null
          error_details?: Json | null
          error_message?: string | null
          expires_at?: string | null
          format?: Database["public"]["Enums"]["export_format_enum"]
          id?: string
          include_corrections?: boolean
          include_issued?: boolean
          include_received?: boolean
          invoices_count?: number
          period_end?: string
          period_start?: string
          progress_message?: string | null
          started_at?: string | null
          status?: Database["public"]["Enums"]["export_status_enum"]
          tenant_id?: string
          total_gross?: number | null
          total_net?: number | null
          total_vat?: number | null
          trigger_source?: Database["public"]["Enums"]["export_trigger_enum"]
          triggered_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "export_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "export_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "export_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "export_jobs_triggered_by_fkey"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      flo_approvals: {
        Row: {
          consumed_at: string | null
          created_at: string
          expires_at: string
          id: string
          proposal_id: string
          snapshot: Json
          tenant_id: string
          user_id: string
        }
        Insert: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          proposal_id: string
          snapshot: Json
          tenant_id: string
          user_id: string
        }
        Update: {
          consumed_at?: string | null
          created_at?: string
          expires_at?: string
          id?: string
          proposal_id?: string
          snapshot?: Json
          tenant_id?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "flo_approvals_proposal_id_fkey"
            columns: ["proposal_id"]
            isOneToOne: false
            referencedRelation: "flo_proposals"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flo_approvals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "flo_approvals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flo_approvals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      flo_decisions: {
        Row: {
          accepted: number
          dismissed: number
          kind: string
          last_at: string
          muted_until: string | null
          tenant_id: string
        }
        Insert: {
          accepted?: number
          dismissed?: number
          kind: string
          last_at?: string
          muted_until?: string | null
          tenant_id: string
        }
        Update: {
          accepted?: number
          dismissed?: number
          kind?: string
          last_at?: string
          muted_until?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "flo_decisions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "flo_decisions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flo_decisions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      flo_kind_flags: {
        Row: {
          enabled: boolean
          kind: string
          reason: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          enabled: boolean
          kind: string
          reason?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          enabled?: boolean
          kind?: string
          reason?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "flo_kind_flags_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "flo_kind_flags_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flo_kind_flags_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      flo_prefs: {
        Row: {
          email_enabled: boolean
          muted_kinds: string[]
          push_enabled: boolean
          quiet_from: string
          quiet_to: string
          tax_profile: Json | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          email_enabled?: boolean
          muted_kinds?: string[]
          push_enabled?: boolean
          quiet_from?: string
          quiet_to?: string
          tax_profile?: Json | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          email_enabled?: boolean
          muted_kinds?: string[]
          push_enabled?: boolean
          quiet_from?: string
          quiet_to?: string
          tax_profile?: Json | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "flo_prefs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "flo_prefs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flo_prefs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      flo_proposals: {
        Row: {
          approved_at: string | null
          approved_by: string | null
          body: string
          created_at: string
          dismissed_reason: string | null
          evidence: Json
          executed_at: string | null
          expires_at: string
          fingerprint: string
          id: string
          kind: string
          payload: Json
          priority: number
          status: string
          tenant_id: string
          title: string
          topic_key: string
        }
        Insert: {
          approved_at?: string | null
          approved_by?: string | null
          body: string
          created_at?: string
          dismissed_reason?: string | null
          evidence?: Json
          executed_at?: string | null
          expires_at: string
          fingerprint: string
          id?: string
          kind: string
          payload?: Json
          priority?: number
          status?: string
          tenant_id: string
          title: string
          topic_key: string
        }
        Update: {
          approved_at?: string | null
          approved_by?: string | null
          body?: string
          created_at?: string
          dismissed_reason?: string | null
          evidence?: Json
          executed_at?: string | null
          expires_at?: string
          fingerprint?: string
          id?: string
          kind?: string
          payload?: Json
          priority?: number
          status?: string
          tenant_id?: string
          title?: string
          topic_key?: string
        }
        Relationships: [
          {
            foreignKeyName: "flo_proposals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "flo_proposals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flo_proposals_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      flo_rollout: {
        Row: {
          complaints: number
          halt_reason: string | null
          halted: boolean
          kind: string
          stage: number
          stage_since: string | null
          updated_at: string
        }
        Insert: {
          complaints?: number
          halt_reason?: string | null
          halted?: boolean
          kind: string
          stage?: number
          stage_since?: string | null
          updated_at?: string
        }
        Update: {
          complaints?: number
          halt_reason?: string | null
          halted?: boolean
          kind?: string
          stage?: number
          stage_since?: string | null
          updated_at?: string
        }
        Relationships: []
      }
      flo_shadow: {
        Row: {
          actual: Json | null
          created_at: string
          id: string
          kind: string
          matched: boolean | null
          proposal: Json
          tenant_id: string
        }
        Insert: {
          actual?: Json | null
          created_at?: string
          id?: string
          kind: string
          matched?: boolean | null
          proposal: Json
          tenant_id: string
        }
        Update: {
          actual?: Json | null
          created_at?: string
          id?: string
          kind?: string
          matched?: boolean | null
          proposal?: Json
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "flo_shadow_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "flo_shadow_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flo_shadow_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      flo_usage: {
        Row: {
          calls: number
          cost_usd: number
          day: string
          input_tokens: number
          output_tokens: number
          tenant_id: string
        }
        Insert: {
          calls?: number
          cost_usd?: number
          day: string
          input_tokens?: number
          output_tokens?: number
          tenant_id: string
        }
        Update: {
          calls?: number
          cost_usd?: number
          day?: string
          input_tokens?: number
          output_tokens?: number
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "flo_usage_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "flo_usage_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "flo_usage_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      gdpr_deletion_requests: {
        Row: {
          cancel_reason: string | null
          cancel_token_hash: string
          executed_at: string | null
          failure_reason: string | null
          id: string
          ip_address: string | null
          processing_started_at: string | null
          requested_at: string
          scheduled_for: string
          status: Database["public"]["Enums"]["gdpr_deletion_status"]
          user_agent: string | null
          user_email: string
          user_id: string | null
        }
        Insert: {
          cancel_reason?: string | null
          cancel_token_hash: string
          executed_at?: string | null
          failure_reason?: string | null
          id?: string
          ip_address?: string | null
          processing_started_at?: string | null
          requested_at?: string
          scheduled_for: string
          status?: Database["public"]["Enums"]["gdpr_deletion_status"]
          user_agent?: string | null
          user_email: string
          user_id?: string | null
        }
        Update: {
          cancel_reason?: string | null
          cancel_token_hash?: string
          executed_at?: string | null
          failure_reason?: string | null
          id?: string
          ip_address?: string | null
          processing_started_at?: string | null
          requested_at?: string
          scheduled_for?: string
          status?: Database["public"]["Enums"]["gdpr_deletion_status"]
          user_agent?: string | null
          user_email?: string
          user_id?: string | null
        }
        Relationships: []
      }
      global_feature_flags: {
        Row: {
          enabled: boolean
          flag: string
          note: string | null
          updated_at: string
          updated_by: string | null
        }
        Insert: {
          enabled?: boolean
          flag: string
          note?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Update: {
          enabled?: boolean
          flag?: string
          note?: string | null
          updated_at?: string
          updated_by?: string | null
        }
        Relationships: []
      }
      import_jobs: {
        Row: {
          completed_at: string | null
          contractors_created: number | null
          contractors_updated: number | null
          created_at: string
          date_from: string | null
          date_to: string | null
          direction: string | null
          id: string
          invoices_found: number | null
          invoices_imported: number | null
          products_created: number | null
          progress_message: string | null
          progress_percent: number
          source: string | null
          source_file_path: string | null
          source_file_size: number | null
          source_filename: string | null
          started_at: string | null
          status: string
          tenant_id: string
          triggered_by: string | null
          updated_at: string
          warnings: Json
        }
        Insert: {
          completed_at?: string | null
          contractors_created?: number | null
          contractors_updated?: number | null
          created_at?: string
          date_from?: string | null
          date_to?: string | null
          direction?: string | null
          id?: string
          invoices_found?: number | null
          invoices_imported?: number | null
          products_created?: number | null
          progress_message?: string | null
          progress_percent?: number
          source?: string | null
          source_file_path?: string | null
          source_file_size?: number | null
          source_filename?: string | null
          started_at?: string | null
          status?: string
          tenant_id: string
          triggered_by?: string | null
          updated_at?: string
          warnings?: Json
        }
        Update: {
          completed_at?: string | null
          contractors_created?: number | null
          contractors_updated?: number | null
          created_at?: string
          date_from?: string | null
          date_to?: string | null
          direction?: string | null
          id?: string
          invoices_found?: number | null
          invoices_imported?: number | null
          products_created?: number | null
          progress_message?: string | null
          progress_percent?: number
          source?: string | null
          source_file_path?: string | null
          source_file_size?: number | null
          source_filename?: string | null
          started_at?: string | null
          status?: string
          tenant_id?: string
          triggered_by?: string | null
          updated_at?: string
          warnings?: Json
        }
        Relationships: [
          {
            foreignKeyName: "import_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "import_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "import_jobs_triggered_by_fkey"
            columns: ["triggered_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      inngest_run_log: {
        Row: {
          created_at: string
          duration_ms: number | null
          error_message: string | null
          event_name: string
          id: string
          invoice_id: string | null
          payload: Json | null
          run_id: string
          status: string
          tenant_id: string | null
        }
        Insert: {
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          event_name: string
          id?: string
          invoice_id?: string | null
          payload?: Json | null
          run_id: string
          status: string
          tenant_id?: string | null
        }
        Update: {
          created_at?: string
          duration_ms?: number | null
          error_message?: string | null
          event_name?: string
          id?: string
          invoice_id?: string | null
          payload?: Json | null
          run_id?: string
          status?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "inngest_run_log_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inngest_run_log_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices_overdue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inngest_run_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "inngest_run_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "inngest_run_log_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      invoice_line_items: {
        Row: {
          gross_amount: number | null
          id: string
          invoice_id: string
          kpir_category: string | null
          name: string | null
          net_amount: number | null
          ordinal: number
          quantity: number | null
          ryczalt_rate: number | null
          unit: string | null
          unit_price_net: number | null
          vat_amount: number | null
          vat_rate: string | null
        }
        Insert: {
          gross_amount?: number | null
          id?: string
          invoice_id: string
          kpir_category?: string | null
          name?: string | null
          net_amount?: number | null
          ordinal: number
          quantity?: number | null
          ryczalt_rate?: number | null
          unit?: string | null
          unit_price_net?: number | null
          vat_amount?: number | null
          vat_rate?: string | null
        }
        Update: {
          gross_amount?: number | null
          id?: string
          invoice_id?: string
          kpir_category?: string | null
          name?: string | null
          net_amount?: number | null
          ordinal?: number
          quantity?: number | null
          ryczalt_rate?: number | null
          unit?: string | null
          unit_price_net?: number | null
          vat_amount?: number | null
          vat_rate?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoice_line_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoice_line_items_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices_overdue"
            referencedColumns: ["id"]
          },
        ]
      }
      invoices: {
        Row: {
          advance_amount: number | null
          advance_invoice_ids: string[]
          archive_storage_path: string | null
          archived_at: string | null
          bank_account_validated: boolean | null
          buyer_data: Json | null
          buyer_id_number: string | null
          buyer_id_type: Database["public"]["Enums"]["buyer_id_type_enum"]
          buyer_nip: string | null
          buyer_pesel: string | null
          buyer_vat_status_at_issue:
            | Database["public"]["Enums"]["vat_status_enum"]
            | null
          correction_reason: string | null
          correction_type:
            | Database["public"]["Enums"]["correction_type_enum"]
            | null
          created_at: string | null
          currency: string | null
          days_to_payment: number | null
          direction: string
          fa3_data: Json
          gross_total: number | null
          id: string
          internal_number: string | null
          invoice_kind: Database["public"]["Enums"]["invoice_type_enum"]
          invoice_type: string | null
          is_b2c: boolean
          issue_date: string
          ksef_accepted_at: string | null
          ksef_environment: string | null
          ksef_number: string | null
          ksef_send_owner: string | null
          ksef_status: string | null
          last_attempt_at: string | null
          last_error: string | null
          last_error_code: string | null
          last_error_field: string | null
          last_error_suggestion: string | null
          net_total: number | null
          notes: string | null
          offline_idempotency_key: string | null
          offline_qr_certyfikat: string | null
          offline_qr_offline: string | null
          origin: string
          paid_amount: number
          paid_at: string | null
          parent_invoice_id: string | null
          payment_data: Json | null
          payment_due_date: string | null
          payment_status: Database["public"]["Enums"]["payment_status_enum"]
          pdf_generated_at: string | null
          pdf_storage_path: string | null
          recurring_invoice_id: string | null
          recurring_period: string | null
          reminders_paused: boolean
          reminders_paused_reason: string | null
          sale_date: string | null
          scheduled_deletion_at: string | null
          seller_data: Json | null
          seller_nip: string | null
          special_data: Json | null
          stripe_invoice_id: string | null
          submission_attempts: number
          submitted_to_ksef_at: string | null
          tenant_id: string
          updated_at: string | null
          validation_warnings: string[] | null
          vat_total: number | null
          xml_generated_at: string | null
          xml_storage_path: string | null
        }
        Insert: {
          advance_amount?: number | null
          advance_invoice_ids?: string[]
          archive_storage_path?: string | null
          archived_at?: string | null
          bank_account_validated?: boolean | null
          buyer_data?: Json | null
          buyer_id_number?: string | null
          buyer_id_type?: Database["public"]["Enums"]["buyer_id_type_enum"]
          buyer_nip?: string | null
          buyer_pesel?: string | null
          buyer_vat_status_at_issue?:
            | Database["public"]["Enums"]["vat_status_enum"]
            | null
          correction_reason?: string | null
          correction_type?:
            | Database["public"]["Enums"]["correction_type_enum"]
            | null
          created_at?: string | null
          currency?: string | null
          days_to_payment?: number | null
          direction: string
          fa3_data: Json
          gross_total?: number | null
          id?: string
          internal_number?: string | null
          invoice_kind?: Database["public"]["Enums"]["invoice_type_enum"]
          invoice_type?: string | null
          is_b2c?: boolean
          issue_date: string
          ksef_accepted_at?: string | null
          ksef_environment?: string | null
          ksef_number?: string | null
          ksef_send_owner?: string | null
          ksef_status?: string | null
          last_attempt_at?: string | null
          last_error?: string | null
          last_error_code?: string | null
          last_error_field?: string | null
          last_error_suggestion?: string | null
          net_total?: number | null
          notes?: string | null
          offline_idempotency_key?: string | null
          offline_qr_certyfikat?: string | null
          offline_qr_offline?: string | null
          origin?: string
          paid_amount?: number
          paid_at?: string | null
          parent_invoice_id?: string | null
          payment_data?: Json | null
          payment_due_date?: string | null
          payment_status?: Database["public"]["Enums"]["payment_status_enum"]
          pdf_generated_at?: string | null
          pdf_storage_path?: string | null
          recurring_invoice_id?: string | null
          recurring_period?: string | null
          reminders_paused?: boolean
          reminders_paused_reason?: string | null
          sale_date?: string | null
          scheduled_deletion_at?: string | null
          seller_data?: Json | null
          seller_nip?: string | null
          special_data?: Json | null
          stripe_invoice_id?: string | null
          submission_attempts?: number
          submitted_to_ksef_at?: string | null
          tenant_id: string
          updated_at?: string | null
          validation_warnings?: string[] | null
          vat_total?: number | null
          xml_generated_at?: string | null
          xml_storage_path?: string | null
        }
        Update: {
          advance_amount?: number | null
          advance_invoice_ids?: string[]
          archive_storage_path?: string | null
          archived_at?: string | null
          bank_account_validated?: boolean | null
          buyer_data?: Json | null
          buyer_id_number?: string | null
          buyer_id_type?: Database["public"]["Enums"]["buyer_id_type_enum"]
          buyer_nip?: string | null
          buyer_pesel?: string | null
          buyer_vat_status_at_issue?:
            | Database["public"]["Enums"]["vat_status_enum"]
            | null
          correction_reason?: string | null
          correction_type?:
            | Database["public"]["Enums"]["correction_type_enum"]
            | null
          created_at?: string | null
          currency?: string | null
          days_to_payment?: number | null
          direction?: string
          fa3_data?: Json
          gross_total?: number | null
          id?: string
          internal_number?: string | null
          invoice_kind?: Database["public"]["Enums"]["invoice_type_enum"]
          invoice_type?: string | null
          is_b2c?: boolean
          issue_date?: string
          ksef_accepted_at?: string | null
          ksef_environment?: string | null
          ksef_number?: string | null
          ksef_send_owner?: string | null
          ksef_status?: string | null
          last_attempt_at?: string | null
          last_error?: string | null
          last_error_code?: string | null
          last_error_field?: string | null
          last_error_suggestion?: string | null
          net_total?: number | null
          notes?: string | null
          offline_idempotency_key?: string | null
          offline_qr_certyfikat?: string | null
          offline_qr_offline?: string | null
          origin?: string
          paid_amount?: number
          paid_at?: string | null
          parent_invoice_id?: string | null
          payment_data?: Json | null
          payment_due_date?: string | null
          payment_status?: Database["public"]["Enums"]["payment_status_enum"]
          pdf_generated_at?: string | null
          pdf_storage_path?: string | null
          recurring_invoice_id?: string | null
          recurring_period?: string | null
          reminders_paused?: boolean
          reminders_paused_reason?: string | null
          sale_date?: string | null
          scheduled_deletion_at?: string | null
          seller_data?: Json | null
          seller_nip?: string | null
          special_data?: Json | null
          stripe_invoice_id?: string | null
          submission_attempts?: number
          submitted_to_ksef_at?: string | null
          tenant_id?: string
          updated_at?: string | null
          validation_warnings?: string[] | null
          vat_total?: number | null
          xml_generated_at?: string | null
          xml_storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_parent_invoice_id_fkey"
            columns: ["parent_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_parent_invoice_id_fkey"
            columns: ["parent_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices_overdue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_recurring_invoice_same_tenant_fk"
            columns: ["tenant_id", "recurring_invoice_id"]
            isOneToOne: false
            referencedRelation: "recurring_invoices"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_tenant_parent_correction_fk"
            columns: ["tenant_id", "parent_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "invoices_tenant_parent_correction_fk"
            columns: ["tenant_id", "parent_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices_overdue"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      kpir_entries: {
        Row: {
          category: string | null
          created_at: string | null
          description: string | null
          entry_date: string
          id: string
          invoice_id: string | null
          net_amount: number | null
          tenant_id: string
          vat_amount: number | null
        }
        Insert: {
          category?: string | null
          created_at?: string | null
          description?: string | null
          entry_date: string
          id?: string
          invoice_id?: string | null
          net_amount?: number | null
          tenant_id: string
          vat_amount?: number | null
        }
        Update: {
          category?: string | null
          created_at?: string | null
          description?: string | null
          entry_date?: string
          id?: string
          invoice_id?: string | null
          net_amount?: number | null
          tenant_id?: string
          vat_amount?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "kpir_entries_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kpir_entries_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices_overdue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kpir_entries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "kpir_entries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "kpir_entries_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      kpir_global_rules: {
        Row: {
          category_label: string
          created_at: string
          id: string
          keyword: string | null
          kpir_column: Database["public"]["Enums"]["kpir_column"]
          nip: string | null
          notes: string | null
        }
        Insert: {
          category_label: string
          created_at?: string
          id?: string
          keyword?: string | null
          kpir_column: Database["public"]["Enums"]["kpir_column"]
          nip?: string | null
          notes?: string | null
        }
        Update: {
          category_label?: string
          created_at?: string
          id?: string
          keyword?: string | null
          kpir_column?: Database["public"]["Enums"]["kpir_column"]
          nip?: string | null
          notes?: string | null
        }
        Relationships: []
      }
      ksef_error_codes: {
        Row: {
          auto_requeue: boolean
          class: string
          client_message: string
          code: string
          created_at: string
        }
        Insert: {
          auto_requeue?: boolean
          class: string
          client_message: string
          code: string
          created_at?: string
        }
        Update: {
          auto_requeue?: boolean
          class?: string
          client_message?: string
          code?: string
          created_at?: string
        }
        Relationships: []
      }
      ksef_health_log: {
        Row: {
          consecutive_failures: number
          env: string
          error_short: string | null
          id: string
          is_mf_outage: boolean
          level: string
          recorded_at: string
          response_time_ms: number | null
        }
        Insert: {
          consecutive_failures?: number
          env: string
          error_short?: string | null
          id?: string
          is_mf_outage?: boolean
          level: string
          recorded_at?: string
          response_time_ms?: number | null
        }
        Update: {
          consecutive_failures?: number
          env?: string
          error_short?: string | null
          id?: string
          is_mf_outage?: boolean
          level?: string
          recorded_at?: string
          response_time_ms?: number | null
        }
        Relationships: []
      }
      ksef_inbox_cursor: {
        Row: {
          announced_count: number
          continuation_token: string | null
          last_page_at: string | null
          saved_count: number
          tenant_id: string
          updated_at: string
          window_from: string | null
          window_to: string | null
        }
        Insert: {
          announced_count?: number
          continuation_token?: string | null
          last_page_at?: string | null
          saved_count?: number
          tenant_id: string
          updated_at?: string
          window_from?: string | null
          window_to?: string | null
        }
        Update: {
          announced_count?: number
          continuation_token?: string | null
          last_page_at?: string | null
          saved_count?: number
          tenant_id?: string
          updated_at?: string
          window_from?: string | null
          window_to?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ksef_inbox_cursor_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "ksef_inbox_cursor_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ksef_inbox_cursor_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ksef_offline_queue: {
        Row: {
          attempts: number
          created_at: string
          deadline: string
          id: string
          idempotency_key: string
          invoice_id: string
          is_mf_outage: boolean
          ksef_environment: string | null
          last_attempt_at: string | null
          last_error: string | null
          max_attempts: number
          next_attempt_at: string
          qr_certyfikat_payload: string | null
          qr_offline_payload: string | null
          status: Database["public"]["Enums"]["offline_queue_status_enum"]
          tenant_id: string
          updated_at: string
          user_notified: boolean
        }
        Insert: {
          attempts?: number
          created_at?: string
          deadline: string
          id?: string
          idempotency_key: string
          invoice_id: string
          is_mf_outage?: boolean
          ksef_environment?: string | null
          last_attempt_at?: string | null
          last_error?: string | null
          max_attempts?: number
          next_attempt_at?: string
          qr_certyfikat_payload?: string | null
          qr_offline_payload?: string | null
          status?: Database["public"]["Enums"]["offline_queue_status_enum"]
          tenant_id: string
          updated_at?: string
          user_notified?: boolean
        }
        Update: {
          attempts?: number
          created_at?: string
          deadline?: string
          id?: string
          idempotency_key?: string
          invoice_id?: string
          is_mf_outage?: boolean
          ksef_environment?: string | null
          last_attempt_at?: string | null
          last_error?: string | null
          max_attempts?: number
          next_attempt_at?: string
          qr_certyfikat_payload?: string | null
          qr_offline_payload?: string | null
          status?: Database["public"]["Enums"]["offline_queue_status_enum"]
          tenant_id?: string
          updated_at?: string
          user_notified?: boolean
        }
        Relationships: [
          {
            foreignKeyName: "ksef_offline_queue_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ksef_offline_queue_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices_overdue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ksef_offline_queue_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "ksef_offline_queue_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ksef_offline_queue_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ksef_send_attempts: {
        Row: {
          error_class: string | null
          error_code: string | null
          error_message: string | null
          execution: number
          finished_at: string | null
          id: string
          invoice_id: string
          job_id: string | null
          ksef_code: number | null
          ksef_environment: string | null
          ksef_http_status: number | null
          result: string | null
          retryable: boolean | null
          send_attempt_id: string | null
          stage: string
          started_at: string
          status: string
          tenant_id: string
          user_id: string | null
          worker_sha: string | null
        }
        Insert: {
          error_class?: string | null
          error_code?: string | null
          error_message?: string | null
          execution?: number
          finished_at?: string | null
          id?: string
          invoice_id: string
          job_id?: string | null
          ksef_code?: number | null
          ksef_environment?: string | null
          ksef_http_status?: number | null
          result?: string | null
          retryable?: boolean | null
          send_attempt_id?: string | null
          stage?: string
          started_at?: string
          status: string
          tenant_id: string
          user_id?: string | null
          worker_sha?: string | null
        }
        Update: {
          error_class?: string | null
          error_code?: string | null
          error_message?: string | null
          execution?: number
          finished_at?: string | null
          id?: string
          invoice_id?: string
          job_id?: string | null
          ksef_code?: number | null
          ksef_environment?: string | null
          ksef_http_status?: number | null
          result?: string | null
          retryable?: boolean | null
          send_attempt_id?: string | null
          stage?: string
          started_at?: string
          status?: string
          tenant_id?: string
          user_id?: string | null
          worker_sha?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ksef_send_attempts_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ksef_send_attempts_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices_overdue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ksef_send_attempts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "ksef_send_attempts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ksef_send_attempts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ksef_send_attempts_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      ksef_sessions: {
        Row: {
          auth_method: string | null
          created_at: string | null
          expires_at: string | null
          id: string
          is_active: boolean | null
          session_token_encrypted: string | null
          tenant_id: string
        }
        Insert: {
          auth_method?: string | null
          created_at?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean | null
          session_token_encrypted?: string | null
          tenant_id: string
        }
        Update: {
          auth_method?: string | null
          created_at?: string | null
          expires_at?: string | null
          id?: string
          is_active?: boolean | null
          session_token_encrypted?: string | null
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ksef_sessions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "ksef_sessions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ksef_sessions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      ksef_submissions: {
        Row: {
          attempted_at: string | null
          completed_at: string | null
          error_code: string | null
          error_message: string | null
          id: string
          invoice_id: string
          invoice_reference_number: string | null
          original_check: Json | null
          original_ksef_number: string | null
          original_session_reference_number: string | null
          request_payload_hash: string | null
          response_ksef_number: string | null
          retry_count: number | null
          session_reference_number: string | null
          status: string | null
          submission_type: string | null
          tenant_id: string
          xml_storage_path: string | null
        }
        Insert: {
          attempted_at?: string | null
          completed_at?: string | null
          error_code?: string | null
          error_message?: string | null
          id?: string
          invoice_id: string
          invoice_reference_number?: string | null
          original_check?: Json | null
          original_ksef_number?: string | null
          original_session_reference_number?: string | null
          request_payload_hash?: string | null
          response_ksef_number?: string | null
          retry_count?: number | null
          session_reference_number?: string | null
          status?: string | null
          submission_type?: string | null
          tenant_id: string
          xml_storage_path?: string | null
        }
        Update: {
          attempted_at?: string | null
          completed_at?: string | null
          error_code?: string | null
          error_message?: string | null
          id?: string
          invoice_id?: string
          invoice_reference_number?: string | null
          original_check?: Json | null
          original_ksef_number?: string | null
          original_session_reference_number?: string | null
          request_payload_hash?: string | null
          response_ksef_number?: string | null
          retry_count?: number | null
          session_reference_number?: string | null
          status?: string | null
          submission_type?: string | null
          tenant_id?: string
          xml_storage_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "ksef_submissions_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ksef_submissions_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices_overdue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ksef_submissions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "ksef_submissions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ksef_submissions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      memberships: {
        Row: {
          created_at: string
          id: string
          invited_at: string | null
          invited_by: string | null
          joined_at: string
          organization_id: string
          revoked_at: string | null
          role: string
          status: string
          updated_at: string
          user_id: string
        }
        Insert: {
          created_at?: string
          id?: string
          invited_at?: string | null
          invited_by?: string | null
          joined_at?: string
          organization_id: string
          revoked_at?: string | null
          role?: string
          status?: string
          updated_at?: string
          user_id: string
        }
        Update: {
          created_at?: string
          id?: string
          invited_at?: string | null
          invited_by?: string | null
          joined_at?: string
          organization_id?: string
          revoked_at?: string | null
          role?: string
          status?: string
          updated_at?: string
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "memberships_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "memberships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "memberships_user_id_fkey"
            columns: ["user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      mfa_recovery_codes: {
        Row: {
          code_hash: string
          code_salt: string
          created_at: string
          id: string
          used_at: string | null
          user_id: string
        }
        Insert: {
          code_hash: string
          code_salt: string
          created_at?: string
          id?: string
          used_at?: string | null
          user_id: string
        }
        Update: {
          code_hash?: string
          code_salt?: string
          created_at?: string
          id?: string
          used_at?: string | null
          user_id?: string
        }
        Relationships: []
      }
      newsletter_subscribers: {
        Row: {
          created_at: string
          email: string
          id: string
          source: string
          unsubscribed_at: string | null
        }
        Insert: {
          created_at?: string
          email: string
          id?: string
          source?: string
          unsubscribed_at?: string | null
        }
        Update: {
          created_at?: string
          email?: string
          id?: string
          source?: string
          unsubscribed_at?: string | null
        }
        Relationships: []
      }
      ocr_jobs: {
        Row: {
          ai_input_tokens: number | null
          ai_model_used: string | null
          ai_output_tokens: number | null
          completed_at: string | null
          created_at: string
          created_by: string | null
          error_message: string | null
          expense_id: string | null
          extracted_data: Json | null
          id: string
          processing_time_ms: number | null
          source_file_mime: string
          source_file_path: string
          source_file_size_bytes: number | null
          status: Database["public"]["Enums"]["ocr_status"]
          tenant_id: string
        }
        Insert: {
          ai_input_tokens?: number | null
          ai_model_used?: string | null
          ai_output_tokens?: number | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error_message?: string | null
          expense_id?: string | null
          extracted_data?: Json | null
          id?: string
          processing_time_ms?: number | null
          source_file_mime: string
          source_file_path: string
          source_file_size_bytes?: number | null
          status?: Database["public"]["Enums"]["ocr_status"]
          tenant_id: string
        }
        Update: {
          ai_input_tokens?: number | null
          ai_model_used?: string | null
          ai_output_tokens?: number | null
          completed_at?: string | null
          created_at?: string
          created_by?: string | null
          error_message?: string | null
          expense_id?: string | null
          extracted_data?: Json | null
          id?: string
          processing_time_ms?: number | null
          source_file_mime?: string
          source_file_path?: string
          source_file_size_bytes?: number | null
          status?: Database["public"]["Enums"]["ocr_status"]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "ocr_jobs_expense_id_fkey"
            columns: ["expense_id"]
            isOneToOne: false
            referencedRelation: "expenses"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ocr_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "ocr_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "ocr_jobs_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_invitations: {
        Row: {
          accepted_at: string | null
          accepted_by_user_id: string | null
          created_at: string
          email: string
          expires_at: string
          id: string
          invited_at: string
          invited_by: string
          organization_id: string
          revoked_at: string | null
          role: string
          token_hash: string
        }
        Insert: {
          accepted_at?: string | null
          accepted_by_user_id?: string | null
          created_at?: string
          email: string
          expires_at?: string
          id?: string
          invited_at?: string
          invited_by: string
          organization_id: string
          revoked_at?: string | null
          role?: string
          token_hash: string
        }
        Update: {
          accepted_at?: string | null
          accepted_by_user_id?: string | null
          created_at?: string
          email?: string
          expires_at?: string
          id?: string
          invited_at?: string
          invited_by?: string
          organization_id?: string
          revoked_at?: string | null
          role?: string
          token_hash?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_invitations_accepted_by_user_id_fkey"
            columns: ["accepted_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_invitations_invited_by_fkey"
            columns: ["invited_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_invitations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "organization_invitations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_invitations_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      organization_join_requests: {
        Row: {
          created_at: string
          decided_at: string | null
          decided_by: string | null
          id: string
          message: string | null
          organization_id: string
          requested_by_user_id: string
          status: string
        }
        Insert: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          message?: string | null
          organization_id: string
          requested_by_user_id: string
          status?: string
        }
        Update: {
          created_at?: string
          decided_at?: string | null
          decided_by?: string | null
          id?: string
          message?: string | null
          organization_id?: string
          requested_by_user_id?: string
          status?: string
        }
        Relationships: [
          {
            foreignKeyName: "organization_join_requests_decided_by_fkey"
            columns: ["decided_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_join_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "organization_join_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_join_requests_organization_id_fkey"
            columns: ["organization_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "organization_join_requests_requested_by_user_id_fkey"
            columns: ["requested_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      payment_imports: {
        Row: {
          account_currency: string
          account_iban: string
          amount: number
          bank_name: string | null
          booking_date: string | null
          counterparty_account: string | null
          counterparty_name: string | null
          counterparty_nip: string | null
          currency: string
          id: string
          ignored: boolean
          imported_at: string
          is_matched: boolean
          matched_payment_id: string | null
          provider: string
          reference: string | null
          tenant_id: string
          title: string | null
          transaction_date: string
          transaction_id: string
        }
        Insert: {
          account_currency?: string
          account_iban: string
          amount: number
          bank_name?: string | null
          booking_date?: string | null
          counterparty_account?: string | null
          counterparty_name?: string | null
          counterparty_nip?: string | null
          currency?: string
          id?: string
          ignored?: boolean
          imported_at?: string
          is_matched?: boolean
          matched_payment_id?: string | null
          provider?: string
          reference?: string | null
          tenant_id: string
          title?: string | null
          transaction_date: string
          transaction_id: string
        }
        Update: {
          account_currency?: string
          account_iban?: string
          amount?: number
          bank_name?: string | null
          booking_date?: string | null
          counterparty_account?: string | null
          counterparty_name?: string | null
          counterparty_nip?: string | null
          currency?: string
          id?: string
          ignored?: boolean
          imported_at?: string
          is_matched?: boolean
          matched_payment_id?: string | null
          provider?: string
          reference?: string | null
          tenant_id?: string
          title?: string | null
          transaction_date?: string
          transaction_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_imports_matched_payment_id_fkey"
            columns: ["matched_payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_imports_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "payment_imports_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_imports_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_imports_tenant_payment_evidence_fk"
            columns: ["tenant_id", "matched_payment_id"]
            isOneToOne: false
            referencedRelation: "payments"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      payment_reminders: {
        Row: {
          channel: Database["public"]["Enums"]["reminder_channel_enum"]
          clicked_at: string | null
          created_at: string
          days_overdue_at_send: number | null
          delivery_status: string | null
          email_body: string | null
          email_message_id: string | null
          email_subject: string | null
          failure_reason: string | null
          id: string
          invoice_id: string
          opened_at: string | null
          opened_count: number
          pdf_attachment_path: string | null
          replied_at: string | null
          scheduled_for: string
          sent_at: string | null
          sms_body: string | null
          sms_message_id: string | null
          stage: Database["public"]["Enums"]["reminder_stage_enum"]
          status: Database["public"]["Enums"]["reminder_status_enum"]
          tenant_id: string
        }
        Insert: {
          channel?: Database["public"]["Enums"]["reminder_channel_enum"]
          clicked_at?: string | null
          created_at?: string
          days_overdue_at_send?: number | null
          delivery_status?: string | null
          email_body?: string | null
          email_message_id?: string | null
          email_subject?: string | null
          failure_reason?: string | null
          id?: string
          invoice_id: string
          opened_at?: string | null
          opened_count?: number
          pdf_attachment_path?: string | null
          replied_at?: string | null
          scheduled_for: string
          sent_at?: string | null
          sms_body?: string | null
          sms_message_id?: string | null
          stage: Database["public"]["Enums"]["reminder_stage_enum"]
          status?: Database["public"]["Enums"]["reminder_status_enum"]
          tenant_id: string
        }
        Update: {
          channel?: Database["public"]["Enums"]["reminder_channel_enum"]
          clicked_at?: string | null
          created_at?: string
          days_overdue_at_send?: number | null
          delivery_status?: string | null
          email_body?: string | null
          email_message_id?: string | null
          email_subject?: string | null
          failure_reason?: string | null
          id?: string
          invoice_id?: string
          opened_at?: string | null
          opened_count?: number
          pdf_attachment_path?: string | null
          replied_at?: string | null
          scheduled_for?: string
          sent_at?: string | null
          sms_body?: string | null
          sms_message_id?: string | null
          stage?: Database["public"]["Enums"]["reminder_stage_enum"]
          status?: Database["public"]["Enums"]["reminder_status_enum"]
          tenant_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "payment_reminders_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_reminders_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices_overdue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_reminders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "payment_reminders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_reminders_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payment_reminders_tenant_invoice_payment_evidence_fk"
            columns: ["tenant_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "payment_reminders_tenant_invoice_payment_evidence_fk"
            columns: ["tenant_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices_overdue"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      payments: {
        Row: {
          amount: number
          bank_import_id: string | null
          bank_payer_account: string | null
          bank_payer_name: string | null
          bank_transaction_ref: string | null
          created_at: string
          id: string
          invoice_id: string
          is_auto_matched: boolean
          is_confirmed: boolean
          match_confidence: number | null
          match_method: string | null
          notes: string | null
          payment_date: string
          payment_method: Database["public"]["Enums"]["payment_method_enum"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          amount: number
          bank_import_id?: string | null
          bank_payer_account?: string | null
          bank_payer_name?: string | null
          bank_transaction_ref?: string | null
          created_at?: string
          id?: string
          invoice_id: string
          is_auto_matched?: boolean
          is_confirmed?: boolean
          match_confidence?: number | null
          match_method?: string | null
          notes?: string | null
          payment_date: string
          payment_method?: Database["public"]["Enums"]["payment_method_enum"]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          amount?: number
          bank_import_id?: string | null
          bank_payer_account?: string | null
          bank_payer_name?: string | null
          bank_transaction_ref?: string | null
          created_at?: string
          id?: string
          invoice_id?: string
          is_auto_matched?: boolean
          is_confirmed?: boolean
          match_confidence?: number | null
          match_method?: string | null
          notes?: string | null
          payment_date?: string
          payment_method?: Database["public"]["Enums"]["payment_method_enum"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices_overdue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "payments_tenant_invoice_payment_evidence_fk"
            columns: ["tenant_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "payments_tenant_invoice_payment_evidence_fk"
            columns: ["tenant_id", "invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices_overdue"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      products: {
        Row: {
          category: string | null
          created_at: string
          default_price_net: number | null
          default_vat_rate: string
          description: string | null
          gtu_code: string | null
          id: string
          is_archived: boolean
          last_used_at: string | null
          name: string
          pkwiu_code: string | null
          tenant_id: string
          unit: string
          updated_at: string
          use_count: number
        }
        Insert: {
          category?: string | null
          created_at?: string
          default_price_net?: number | null
          default_vat_rate?: string
          description?: string | null
          gtu_code?: string | null
          id?: string
          is_archived?: boolean
          last_used_at?: string | null
          name: string
          pkwiu_code?: string | null
          tenant_id: string
          unit?: string
          updated_at?: string
          use_count?: number
        }
        Update: {
          category?: string | null
          created_at?: string
          default_price_net?: number | null
          default_vat_rate?: string
          description?: string | null
          gtu_code?: string | null
          id?: string
          is_archived?: boolean
          last_used_at?: string | null
          name?: string
          pkwiu_code?: string | null
          tenant_id?: string
          unit?: string
          updated_at?: string
          use_count?: number
        }
        Relationships: [
          {
            foreignKeyName: "products_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "products_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "products_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      push_subscriptions: {
        Row: {
          auth: string
          created_at: string
          device_name: string | null
          device_type: string | null
          endpoint: string
          failed_count: number
          id: string
          is_active: boolean
          last_used_at: string | null
          notify_cert_expiry: boolean
          notify_inbox_new: boolean
          notify_invoice_accepted: boolean
          notify_invoice_rejected: boolean
          notify_payment_received: boolean
          p256dh: string
          tenant_id: string
          updated_at: string
          user_agent: string | null
          user_id: string
        }
        Insert: {
          auth: string
          created_at?: string
          device_name?: string | null
          device_type?: string | null
          endpoint: string
          failed_count?: number
          id?: string
          is_active?: boolean
          last_used_at?: string | null
          notify_cert_expiry?: boolean
          notify_inbox_new?: boolean
          notify_invoice_accepted?: boolean
          notify_invoice_rejected?: boolean
          notify_payment_received?: boolean
          p256dh: string
          tenant_id: string
          updated_at?: string
          user_agent?: string | null
          user_id: string
        }
        Update: {
          auth?: string
          created_at?: string
          device_name?: string | null
          device_type?: string | null
          endpoint?: string
          failed_count?: number
          id?: string
          is_active?: boolean
          last_used_at?: string | null
          notify_cert_expiry?: boolean
          notify_inbox_new?: boolean
          notify_invoice_accepted?: boolean
          notify_invoice_rejected?: boolean
          notify_payment_received?: boolean
          p256dh?: string
          tenant_id?: string
          updated_at?: string
          user_agent?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "push_subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "push_subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "push_subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      recurring_invoices: {
        Row: {
          active: boolean
          created_at: string
          created_by: string | null
          day_of_month: number
          frequency: string
          id: string
          name: string
          next_run_date: string
          template_invoice_id: string
          tenant_id: string
          updated_at: string
        }
        Insert: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          day_of_month: number
          frequency: string
          id?: string
          name: string
          next_run_date: string
          template_invoice_id: string
          tenant_id: string
          updated_at?: string
        }
        Update: {
          active?: boolean
          created_at?: string
          created_by?: string | null
          day_of_month?: number
          frequency?: string
          id?: string
          name?: string
          next_run_date?: string
          template_invoice_id?: string
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "recurring_invoices_created_by_fkey"
            columns: ["created_by"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recurring_invoices_template_same_tenant_fk"
            columns: ["tenant_id", "template_invoice_id"]
            isOneToOne: true
            referencedRelation: "invoices"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "recurring_invoices_template_same_tenant_fk"
            columns: ["tenant_id", "template_invoice_id"]
            isOneToOne: true
            referencedRelation: "invoices_overdue"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "recurring_invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "recurring_invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "recurring_invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      reminder_settings: {
        Row: {
          created_at: string
          enabled: boolean
          id: string
          max_reminders_per_invoice: number
          pause_on_partial_payment: boolean
          pause_on_reply: boolean
          reply_to_email: string | null
          send_hour: number
          send_on_weekdays_only: boolean
          sender_email: string | null
          sender_name: string | null
          stage_1_days_after_due: number
          stage_1_enabled: boolean
          stage_2_days_after_due: number
          stage_2_enabled: boolean
          stage_3_days_after_due: number
          stage_3_enabled: boolean
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          enabled?: boolean
          id?: string
          max_reminders_per_invoice?: number
          pause_on_partial_payment?: boolean
          pause_on_reply?: boolean
          reply_to_email?: string | null
          send_hour?: number
          send_on_weekdays_only?: boolean
          sender_email?: string | null
          sender_name?: string | null
          stage_1_days_after_due?: number
          stage_1_enabled?: boolean
          stage_2_days_after_due?: number
          stage_2_enabled?: boolean
          stage_3_days_after_due?: number
          stage_3_enabled?: boolean
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          enabled?: boolean
          id?: string
          max_reminders_per_invoice?: number
          pause_on_partial_payment?: boolean
          pause_on_reply?: boolean
          reply_to_email?: string | null
          send_hour?: number
          send_on_weekdays_only?: boolean
          sender_email?: string | null
          sender_name?: string | null
          stage_1_days_after_due?: number
          stage_1_enabled?: boolean
          stage_2_days_after_due?: number
          stage_2_enabled?: boolean
          stage_3_days_after_due?: number
          stage_3_enabled?: boolean
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reminder_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "reminder_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reminder_settings_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      reminder_templates: {
        Row: {
          created_at: string
          email_body: string
          email_subject: string
          id: string
          is_default: boolean
          stage: Database["public"]["Enums"]["reminder_stage_enum"]
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          email_body: string
          email_subject: string
          id?: string
          is_default?: boolean
          stage: Database["public"]["Enums"]["reminder_stage_enum"]
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          email_body?: string
          email_subject?: string
          id?: string
          is_default?: boolean
          stage?: Database["public"]["Enums"]["reminder_stage_enum"]
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "reminder_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "reminder_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "reminder_templates_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_checkout_attempts: {
        Row: {
          created_at: string
          id: string
          plan: string
          session_expires_at: string | null
          status: string
          stripe_customer_id: string
          stripe_price_id: string
          stripe_session_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          plan: string
          session_expires_at?: string | null
          status?: string
          stripe_customer_id: string
          stripe_price_id: string
          stripe_session_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          plan?: string
          session_expires_at?: string | null
          status?: string
          stripe_customer_id?: string
          stripe_price_id?: string
          stripe_session_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_checkout_attempts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "stripe_checkout_attempts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_checkout_attempts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_customer_attempts: {
        Row: {
          created_at: string
          id: string
          status: string
          stripe_customer_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          created_at?: string
          id?: string
          status?: string
          stripe_customer_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          created_at?: string
          id?: string
          status?: string
          stripe_customer_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_customer_attempts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "stripe_customer_attempts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_customer_attempts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_financial_case_refs: {
        Row: {
          reference_id: string
          reference_kind: string
          stripe_object_id: string
        }
        Insert: {
          reference_id: string
          reference_kind: string
          stripe_object_id: string
        }
        Update: {
          reference_id?: string
          reference_kind?: string
          stripe_object_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_financial_case_refs_stripe_object_id_fkey"
            columns: ["stripe_object_id"]
            isOneToOne: false
            referencedRelation: "stripe_financial_cases"
            referencedColumns: ["stripe_object_id"]
          },
        ]
      }
      stripe_financial_case_reopenings: {
        Row: {
          event_id: string | null
          id: string
          new_candidate_count: number | null
          new_candidate_payment_id: string | null
          new_case_state: string
          observed_stripe_status: string
          previous_candidate_count: number | null
          previous_candidate_payment_id: string | null
          previous_stripe_status: string
          reopened_at: string
          source: string
          stripe_object_id: string
        }
        Insert: {
          event_id?: string | null
          id?: string
          new_candidate_count?: number | null
          new_candidate_payment_id?: string | null
          new_case_state: string
          observed_stripe_status: string
          previous_candidate_count?: number | null
          previous_candidate_payment_id?: string | null
          previous_stripe_status: string
          reopened_at?: string
          source: string
          stripe_object_id: string
        }
        Update: {
          event_id?: string | null
          id?: string
          new_candidate_count?: number | null
          new_candidate_payment_id?: string | null
          new_case_state?: string
          observed_stripe_status?: string
          previous_candidate_count?: number | null
          previous_candidate_payment_id?: string | null
          previous_stripe_status?: string
          reopened_at?: string
          source?: string
          stripe_object_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_financial_case_reopenings_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "stripe_webhook_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_financial_case_reopenings_stripe_object_id_fkey"
            columns: ["stripe_object_id"]
            isOneToOne: false
            referencedRelation: "stripe_financial_cases"
            referencedColumns: ["stripe_object_id"]
          },
        ]
      }
      stripe_financial_case_reviews: {
        Row: {
          candidate_count: number
          candidate_payment_id: string | null
          evidence_reference: string
          hold_after: boolean
          id: string
          last_event_id: string
          observed_stripe_status: string
          previous_state: string
          reason: string
          reviewed_at: string
          reviewer_user_id: string
          stripe_object_id: string
        }
        Insert: {
          candidate_count: number
          candidate_payment_id?: string | null
          evidence_reference: string
          hold_after?: boolean
          id?: string
          last_event_id: string
          observed_stripe_status: string
          previous_state: string
          reason: string
          reviewed_at?: string
          reviewer_user_id: string
          stripe_object_id: string
        }
        Update: {
          candidate_count?: number
          candidate_payment_id?: string | null
          evidence_reference?: string
          hold_after?: boolean
          id?: string
          last_event_id?: string
          observed_stripe_status?: string
          previous_state?: string
          reason?: string
          reviewed_at?: string
          reviewer_user_id?: string
          stripe_object_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_financial_case_reviews_last_event_id_fkey"
            columns: ["last_event_id"]
            isOneToOne: false
            referencedRelation: "stripe_webhook_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_financial_case_reviews_stripe_object_id_fkey"
            columns: ["stripe_object_id"]
            isOneToOne: false
            referencedRelation: "stripe_financial_cases"
            referencedColumns: ["stripe_object_id"]
          },
        ]
      }
      stripe_financial_cases: {
        Row: {
          amount_cents: number
          case_state: string
          currency: string
          first_event_id: string
          first_seen_at: string
          hold_active: boolean
          kind: string
          last_event_id: string
          last_observed_status: string
          last_seen_at: string
          payment_id: string | null
          quarantine_reason: string | null
          reviewed_at: string | null
          reviewed_candidate_count: number | null
          reviewed_candidate_payment_id: string | null
          settled_at: string | null
          stripe_object_id: string
          stripe_status: string
          tenant_id: string | null
        }
        Insert: {
          amount_cents: number
          case_state: string
          currency: string
          first_event_id: string
          first_seen_at?: string
          hold_active?: boolean
          kind: string
          last_event_id: string
          last_observed_status: string
          last_seen_at?: string
          payment_id?: string | null
          quarantine_reason?: string | null
          reviewed_at?: string | null
          reviewed_candidate_count?: number | null
          reviewed_candidate_payment_id?: string | null
          settled_at?: string | null
          stripe_object_id: string
          stripe_status: string
          tenant_id?: string | null
        }
        Update: {
          amount_cents?: number
          case_state?: string
          currency?: string
          first_event_id?: string
          first_seen_at?: string
          hold_active?: boolean
          kind?: string
          last_event_id?: string
          last_observed_status?: string
          last_seen_at?: string
          payment_id?: string | null
          quarantine_reason?: string | null
          reviewed_at?: string | null
          reviewed_candidate_count?: number | null
          reviewed_candidate_payment_id?: string | null
          settled_at?: string | null
          stripe_object_id?: string
          stripe_status?: string
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stripe_financial_cases_first_event_id_fkey"
            columns: ["first_event_id"]
            isOneToOne: false
            referencedRelation: "stripe_webhook_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_financial_cases_last_event_id_fkey"
            columns: ["last_event_id"]
            isOneToOne: false
            referencedRelation: "stripe_webhook_events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_financial_cases_payment_tenant_fk"
            columns: ["tenant_id", "payment_id"]
            isOneToOne: false
            referencedRelation: "stripe_payments"
            referencedColumns: ["tenant_id", "id"]
          },
        ]
      }
      stripe_payments: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          failure_reason: string | null
          id: string
          last_webhook_payload: Json | null
          paid_at: string | null
          status: Database["public"]["Enums"]["stripe_payment_status_enum"]
          stripe_charge_id: string | null
          stripe_invoice_id: string | null
          stripe_payment_intent_id: string | null
          stripe_payment_refs_verified: boolean
          subscription_id: string | null
          tax_cents: number
          tenant_id: string
          updated_at: string
          vat_invoice_id: string | null
          vat_invoice_submitted_at: string | null
        }
        Insert: {
          amount_cents: number
          created_at?: string
          currency: string
          failure_reason?: string | null
          id?: string
          last_webhook_payload?: Json | null
          paid_at?: string | null
          status: Database["public"]["Enums"]["stripe_payment_status_enum"]
          stripe_charge_id?: string | null
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_payment_refs_verified?: boolean
          subscription_id?: string | null
          tax_cents?: number
          tenant_id: string
          updated_at?: string
          vat_invoice_id?: string | null
          vat_invoice_submitted_at?: string | null
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          failure_reason?: string | null
          id?: string
          last_webhook_payload?: Json | null
          paid_at?: string | null
          status?: Database["public"]["Enums"]["stripe_payment_status_enum"]
          stripe_charge_id?: string | null
          stripe_invoice_id?: string | null
          stripe_payment_intent_id?: string | null
          stripe_payment_refs_verified?: boolean
          subscription_id?: string | null
          tax_cents?: number
          tenant_id?: string
          updated_at?: string
          vat_invoice_id?: string | null
          vat_invoice_submitted_at?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stripe_payments_subscription_id_fkey"
            columns: ["subscription_id"]
            isOneToOne: false
            referencedRelation: "subscriptions"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "stripe_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_payments_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_payments_vat_invoice_id_fkey"
            columns: ["vat_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_payments_vat_invoice_id_fkey"
            columns: ["vat_invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices_overdue"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_refund_operations: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          idempotency_key: string
          payment_id: string
          reason: string | null
          reconciliation_reason: string | null
          refund_id: string | null
          requested_by_user_id: string | null
          status: string
          stripe_payment_reference: string | null
          stripe_refund_id: string | null
          tenant_id: string
          updated_at: string
        }
        Insert: {
          amount_cents: number
          created_at?: string
          currency: string
          idempotency_key: string
          payment_id: string
          reason?: string | null
          reconciliation_reason?: string | null
          refund_id?: string | null
          requested_by_user_id?: string | null
          status?: string
          stripe_payment_reference?: string | null
          stripe_refund_id?: string | null
          tenant_id: string
          updated_at?: string
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          idempotency_key?: string
          payment_id?: string
          reason?: string | null
          reconciliation_reason?: string | null
          refund_id?: string | null
          requested_by_user_id?: string | null
          status?: string
          stripe_payment_reference?: string | null
          stripe_refund_id?: string | null
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "stripe_refund_operations_payment_tenant_fk"
            columns: ["tenant_id", "payment_id"]
            isOneToOne: false
            referencedRelation: "stripe_payments"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "stripe_refund_operations_refund_id_fkey"
            columns: ["refund_id"]
            isOneToOne: false
            referencedRelation: "stripe_refunds"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_refund_operations_refund_payment_fk"
            columns: ["payment_id", "refund_id"]
            isOneToOne: false
            referencedRelation: "stripe_refunds"
            referencedColumns: ["payment_id", "id"]
          },
          {
            foreignKeyName: "stripe_refund_operations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "stripe_refund_operations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_refund_operations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_refunds: {
        Row: {
          amount_cents: number
          created_at: string
          currency: string
          id: string
          payment_id: string
          reason: string | null
          status: string
          stripe_refund_id: string
          tenant_id: string
          triggered_by_user_id: string | null
        }
        Insert: {
          amount_cents: number
          created_at?: string
          currency: string
          id?: string
          payment_id: string
          reason?: string | null
          status: string
          stripe_refund_id: string
          tenant_id: string
          triggered_by_user_id?: string | null
        }
        Update: {
          amount_cents?: number
          created_at?: string
          currency?: string
          id?: string
          payment_id?: string
          reason?: string | null
          status?: string
          stripe_refund_id?: string
          tenant_id?: string
          triggered_by_user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "stripe_refunds_payment_id_fkey"
            columns: ["payment_id"]
            isOneToOne: false
            referencedRelation: "stripe_payments"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_refunds_payment_tenant_fk"
            columns: ["tenant_id", "payment_id"]
            isOneToOne: false
            referencedRelation: "stripe_payments"
            referencedColumns: ["tenant_id", "id"]
          },
          {
            foreignKeyName: "stripe_refunds_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "stripe_refunds_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "stripe_refunds_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      stripe_subscription_sync_leases: {
        Row: {
          claim_token: string | null
          claimed_at: string | null
          fence: number
          lease_expires_at: string | null
          stripe_subscription_id: string
          updated_at: string
        }
        Insert: {
          claim_token?: string | null
          claimed_at?: string | null
          fence?: number
          lease_expires_at?: string | null
          stripe_subscription_id: string
          updated_at?: string
        }
        Update: {
          claim_token?: string | null
          claimed_at?: string | null
          fence?: number
          lease_expires_at?: string | null
          stripe_subscription_id?: string
          updated_at?: string
        }
        Relationships: []
      }
      stripe_webhook_events: {
        Row: {
          claim_attempt_count: number
          claim_started_at: string | null
          claim_token: string | null
          id: string
          payload: Json
          processed_at: string | null
          processing_error: string | null
          processing_status: string
          received_at: string
          type: string
        }
        Insert: {
          claim_attempt_count?: number
          claim_started_at?: string | null
          claim_token?: string | null
          id: string
          payload: Json
          processed_at?: string | null
          processing_error?: string | null
          processing_status?: string
          received_at?: string
          type: string
        }
        Update: {
          claim_attempt_count?: number
          claim_started_at?: string | null
          claim_token?: string | null
          id?: string
          payload?: Json
          processed_at?: string | null
          processing_error?: string | null
          processing_status?: string
          received_at?: string
          type?: string
        }
        Relationships: []
      }
      subscriptions: {
        Row: {
          cancel_at_period_end: boolean
          canceled_at: string | null
          created_at: string
          current_period_end: string | null
          current_period_start: string | null
          id: string
          last_webhook_at: string | null
          last_webhook_payload: Json | null
          plan: Database["public"]["Enums"]["subscription_plan_enum"]
          status: Database["public"]["Enums"]["subscription_status_enum"]
          stripe_customer_id: string
          stripe_price_id: string
          stripe_subscription_id: string
          tenant_id: string
          trial_end: string | null
          trial_start: string | null
          updated_at: string
        }
        Insert: {
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          last_webhook_at?: string | null
          last_webhook_payload?: Json | null
          plan: Database["public"]["Enums"]["subscription_plan_enum"]
          status: Database["public"]["Enums"]["subscription_status_enum"]
          stripe_customer_id: string
          stripe_price_id: string
          stripe_subscription_id: string
          tenant_id: string
          trial_end?: string | null
          trial_start?: string | null
          updated_at?: string
        }
        Update: {
          cancel_at_period_end?: boolean
          canceled_at?: string | null
          created_at?: string
          current_period_end?: string | null
          current_period_start?: string | null
          id?: string
          last_webhook_at?: string | null
          last_webhook_payload?: Json | null
          plan?: Database["public"]["Enums"]["subscription_plan_enum"]
          status?: Database["public"]["Enums"]["subscription_status_enum"]
          stripe_customer_id?: string
          stripe_price_id?: string
          stripe_subscription_id?: string
          tenant_id?: string
          trial_end?: string | null
          trial_start?: string | null
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "subscriptions_tenant_customer_fk"
            columns: ["tenant_id", "stripe_customer_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id", "stripe_customer_id"]
          },
          {
            foreignKeyName: "subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "subscriptions_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      support_conversations: {
        Row: {
          category: Database["public"]["Enums"]["support_category"] | null
          created_at: string
          csat_comment: string | null
          csat_positive: boolean | null
          escalated_at: string | null
          escalation_reason: string | null
          id: string
          status: Database["public"]["Enums"]["support_conversation_status"]
          subject: string | null
          tenant_id: string | null
          updated_at: string
          user_id: string | null
        }
        Insert: {
          category?: Database["public"]["Enums"]["support_category"] | null
          created_at?: string
          csat_comment?: string | null
          csat_positive?: boolean | null
          escalated_at?: string | null
          escalation_reason?: string | null
          id?: string
          status?: Database["public"]["Enums"]["support_conversation_status"]
          subject?: string | null
          tenant_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Update: {
          category?: Database["public"]["Enums"]["support_category"] | null
          created_at?: string
          csat_comment?: string | null
          csat_positive?: boolean | null
          escalated_at?: string | null
          escalation_reason?: string | null
          id?: string
          status?: Database["public"]["Enums"]["support_conversation_status"]
          subject?: string | null
          tenant_id?: string | null
          updated_at?: string
          user_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "support_conversations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "support_conversations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "support_conversations_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      support_messages: {
        Row: {
          ai_uncertain: boolean
          cited_articles: string[] | null
          content: string
          conversation_id: string
          created_at: string
          id: string
          role: Database["public"]["Enums"]["support_message_role"]
        }
        Insert: {
          ai_uncertain?: boolean
          cited_articles?: string[] | null
          content: string
          conversation_id: string
          created_at?: string
          id?: string
          role: Database["public"]["Enums"]["support_message_role"]
        }
        Update: {
          ai_uncertain?: boolean
          cited_articles?: string[] | null
          content?: string
          conversation_id?: string
          created_at?: string
          id?: string
          role?: Database["public"]["Enums"]["support_message_role"]
        }
        Relationships: [
          {
            foreignKeyName: "support_messages_conversation_id_fkey"
            columns: ["conversation_id"]
            isOneToOne: false
            referencedRelation: "support_conversations"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_feature_flags: {
        Row: {
          co_pilot_enabled: boolean
          exports_enabled: boolean
          magic_import_enabled: boolean
          tenant_id: string
          updated_at: string
        }
        Insert: {
          co_pilot_enabled?: boolean
          exports_enabled?: boolean
          magic_import_enabled?: boolean
          tenant_id: string
          updated_at?: string
        }
        Update: {
          co_pilot_enabled?: boolean
          exports_enabled?: boolean
          magic_import_enabled?: boolean
          tenant_id?: string
          updated_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "tenant_feature_flags_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "tenant_feature_flags_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenant_feature_flags_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: true
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenants: {
        Row: {
          address_json: Json | null
          business_started_on: string | null
          created_at: string | null
          created_by_user_id: string | null
          deleted_at: string | null
          hard_delete_at: string | null
          has_ksef_credentials: boolean | null
          id: string
          is_active: boolean
          ksef_authority_user_id: string | null
          ksef_certificate_expiry: string | null
          ksef_credentials_encrypted: string | null
          ksef_verified_at: string | null
          ksef_verified_environment: string | null
          name: string
          nip: string
          regon: string | null
          retention_years: number
          stripe_customer_id: string | null
          subscription_tier: string | null
          tax_office_code: string | null
          updated_at: string | null
          vat_cash_method: boolean
          vat_exemption_basis: string | null
        }
        Insert: {
          address_json?: Json | null
          business_started_on?: string | null
          created_at?: string | null
          created_by_user_id?: string | null
          deleted_at?: string | null
          hard_delete_at?: string | null
          has_ksef_credentials?: boolean | null
          id?: string
          is_active?: boolean
          ksef_authority_user_id?: string | null
          ksef_certificate_expiry?: string | null
          ksef_credentials_encrypted?: string | null
          ksef_verified_at?: string | null
          ksef_verified_environment?: string | null
          name: string
          nip: string
          regon?: string | null
          retention_years?: number
          stripe_customer_id?: string | null
          subscription_tier?: string | null
          tax_office_code?: string | null
          updated_at?: string | null
          vat_cash_method?: boolean
          vat_exemption_basis?: string | null
        }
        Update: {
          address_json?: Json | null
          business_started_on?: string | null
          created_at?: string | null
          created_by_user_id?: string | null
          deleted_at?: string | null
          hard_delete_at?: string | null
          has_ksef_credentials?: boolean | null
          id?: string
          is_active?: boolean
          ksef_authority_user_id?: string | null
          ksef_certificate_expiry?: string | null
          ksef_credentials_encrypted?: string | null
          ksef_verified_at?: string | null
          ksef_verified_environment?: string | null
          name?: string
          nip?: string
          regon?: string | null
          retention_years?: number
          stripe_customer_id?: string | null
          subscription_tier?: string | null
          tax_office_code?: string | null
          updated_at?: string | null
          vat_cash_method?: boolean
          vat_exemption_basis?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenants_created_by_user_id_fkey"
            columns: ["created_by_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "tenants_ksef_authority_user_id_fkey"
            columns: ["ksef_authority_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
      upo_receipts: {
        Row: {
          archive_glacier_key: string | null
          archived_at: string | null
          created_at: string
          download_attempts: number
          downloaded_at: string | null
          id: string
          invoice_id: string
          ksef_acceptance_timestamp: string
          ksef_environment: string | null
          ksef_number: string
          last_error: string | null
          status: Database["public"]["Enums"]["upo_status_enum"]
          tenant_id: string
          upo_id: string | null
          upo_pdf_path: string | null
          upo_xml_hash: string | null
          upo_xml_path: string | null
        }
        Insert: {
          archive_glacier_key?: string | null
          archived_at?: string | null
          created_at?: string
          download_attempts?: number
          downloaded_at?: string | null
          id?: string
          invoice_id: string
          ksef_acceptance_timestamp: string
          ksef_environment?: string | null
          ksef_number: string
          last_error?: string | null
          status?: Database["public"]["Enums"]["upo_status_enum"]
          tenant_id: string
          upo_id?: string | null
          upo_pdf_path?: string | null
          upo_xml_hash?: string | null
          upo_xml_path?: string | null
        }
        Update: {
          archive_glacier_key?: string | null
          archived_at?: string | null
          created_at?: string
          download_attempts?: number
          downloaded_at?: string | null
          id?: string
          invoice_id?: string
          ksef_acceptance_timestamp?: string
          ksef_environment?: string | null
          ksef_number?: string
          last_error?: string | null
          status?: Database["public"]["Enums"]["upo_status_enum"]
          tenant_id?: string
          upo_id?: string | null
          upo_pdf_path?: string | null
          upo_xml_hash?: string | null
          upo_xml_path?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "upo_receipts_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: true
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "upo_receipts_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: true
            referencedRelation: "invoices_overdue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "upo_receipts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "upo_receipts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "upo_receipts_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      users: {
        Row: {
          created_at: string | null
          id: string
          last_active_tenant_id: string | null
          last_login: string | null
          name: string | null
        }
        Insert: {
          created_at?: string | null
          id: string
          last_active_tenant_id?: string | null
          last_login?: string | null
          name?: string | null
        }
        Update: {
          created_at?: string | null
          id?: string
          last_active_tenant_id?: string | null
          last_login?: string | null
          name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "users_last_active_tenant_id_fkey"
            columns: ["last_active_tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "users_last_active_tenant_id_fkey"
            columns: ["last_active_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "users_last_active_tenant_id_fkey"
            columns: ["last_active_tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      validation_cache: {
        Row: {
          bank_accounts: string[] | null
          cached_at: string
          country_code: string
          expires_at: string
          hit_count: number
          id: string
          is_valid: boolean | null
          legal_name: string | null
          nip: string
          raw_response: Json | null
          registered_address: string | null
          registration_date: string | null
          source: Database["public"]["Enums"]["validation_source_enum"]
          termination_date: string | null
          vat_status: Database["public"]["Enums"]["vat_status_enum"] | null
        }
        Insert: {
          bank_accounts?: string[] | null
          cached_at?: string
          country_code?: string
          expires_at?: string
          hit_count?: number
          id?: string
          is_valid?: boolean | null
          legal_name?: string | null
          nip: string
          raw_response?: Json | null
          registered_address?: string | null
          registration_date?: string | null
          source: Database["public"]["Enums"]["validation_source_enum"]
          termination_date?: string | null
          vat_status?: Database["public"]["Enums"]["vat_status_enum"] | null
        }
        Update: {
          bank_accounts?: string[] | null
          cached_at?: string
          country_code?: string
          expires_at?: string
          hit_count?: number
          id?: string
          is_valid?: boolean | null
          legal_name?: string | null
          nip?: string
          raw_response?: Json | null
          registered_address?: string | null
          registration_date?: string | null
          source?: Database["public"]["Enums"]["validation_source_enum"]
          termination_date?: string | null
          vat_status?: Database["public"]["Enums"]["vat_status_enum"] | null
        }
        Relationships: []
      }
      xml_documents: {
        Row: {
          created_at: string | null
          file_size_bytes: number | null
          id: string
          invoice_id: string
          sha256_hash: string
          storage_path: string
          storage_provider: string | null
          tenant_id: string
          version: number | null
        }
        Insert: {
          created_at?: string | null
          file_size_bytes?: number | null
          id?: string
          invoice_id: string
          sha256_hash: string
          storage_path: string
          storage_provider?: string | null
          tenant_id: string
          version?: number | null
        }
        Update: {
          created_at?: string | null
          file_size_bytes?: number | null
          id?: string
          invoice_id?: string
          sha256_hash?: string
          storage_path?: string
          storage_provider?: string | null
          tenant_id?: string
          version?: number | null
        }
        Relationships: [
          {
            foreignKeyName: "xml_documents_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "xml_documents_invoice_id_fkey"
            columns: ["invoice_id"]
            isOneToOne: false
            referencedRelation: "invoices_overdue"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "xml_documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "xml_documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "xml_documents_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      invoices_overdue: {
        Row: {
          amount_due: number | null
          buyer_email: string | null
          buyer_name: string | null
          buyer_nip: string | null
          days_overdue: number | null
          gross_total: number | null
          id: string | null
          internal_number: string | null
          issue_date: string | null
          paid_amount: number | null
          payment_due_date: string | null
          payment_status:
            | Database["public"]["Enums"]["payment_status_enum"]
            | null
          reminders_paused: boolean | null
          reminders_sent_count: number | null
          tenant_id: string | null
        }
        Insert: {
          amount_due?: never
          buyer_email?: never
          buyer_name?: never
          buyer_nip?: never
          days_overdue?: never
          gross_total?: number | null
          id?: string | null
          internal_number?: string | null
          issue_date?: string | null
          paid_amount?: number | null
          payment_due_date?: string | null
          payment_status?:
            | Database["public"]["Enums"]["payment_status_enum"]
            | null
          reminders_paused?: boolean | null
          reminders_sent_count?: never
          tenant_id?: string | null
        }
        Update: {
          amount_due?: never
          buyer_email?: never
          buyer_name?: never
          buyer_nip?: never
          days_overdue?: never
          gross_total?: number | null
          id?: string | null
          internal_number?: string | null
          issue_date?: string | null
          paid_amount?: number | null
          payment_due_date?: string | null
          payment_status?:
            | Database["public"]["Enums"]["payment_status_enum"]
            | null
          reminders_paused?: boolean | null
          reminders_sent_count?: never
          tenant_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      mv_tenant_dashboard_summary: {
        Row: {
          current_month_accepted: number | null
          current_month_count: number | null
          current_month_gross: number | null
          current_month_net: number | null
          current_month_vat: number | null
          prev_month_count: number | null
          refreshed_at: string | null
          tenant_id: string | null
          unpaid_amount: number | null
          unpaid_count: number | null
        }
        Relationships: []
      }
      mv_tenant_monthly_stats: {
        Row: {
          accepted_count: number | null
          direction: string | null
          invoice_count: number | null
          last_invoice_at: string | null
          paid_count: number | null
          rejected_count: number | null
          tenant_id: string | null
          total_gross: number | null
          total_net: number | null
          total_paid: number | null
          total_vat: number | null
          unpaid_count: number | null
          year_month: string | null
        }
        Relationships: [
          {
            foreignKeyName: "invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "mv_tenant_dashboard_summary"
            referencedColumns: ["tenant_id"]
          },
          {
            foreignKeyName: "invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenant_verification_status"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "invoices_tenant_id_fkey"
            columns: ["tenant_id"]
            isOneToOne: false
            referencedRelation: "tenants"
            referencedColumns: ["id"]
          },
        ]
      }
      tenant_verification_status: {
        Row: {
          id: string | null
          is_ksef_verified: boolean | null
          ksef_authority_user_id: string | null
          ksef_verified_at: string | null
          name: string | null
          nip: string | null
          verified_environment: string | null
        }
        Insert: {
          id?: string | null
          is_ksef_verified?: never
          ksef_authority_user_id?: string | null
          ksef_verified_at?: string | null
          name?: string | null
          nip?: string | null
          verified_environment?: string | null
        }
        Update: {
          id?: string | null
          is_ksef_verified?: never
          ksef_authority_user_id?: string | null
          ksef_verified_at?: string | null
          name?: string | null
          nip?: string | null
          verified_environment?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "tenants_ksef_authority_user_id_fkey"
            columns: ["ksef_authority_user_id"]
            isOneToOne: false
            referencedRelation: "users"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Functions: {
      abandon_stripe_checkout_attempt: {
        Args: { p_attempt_id: string }
        Returns: boolean
      }
      accept_organization_invitation: {
        Args: { p_token_hash: string }
        Returns: string
      }
      admin_database_size: { Args: never; Returns: number }
      admin_refund_financial_preflight: {
        Args: { p_payment_id: string }
        Returns: string
      }
      admin_table_sizes: {
        Args: never
        Returns: {
          row_estimate: number
          table_name: string
          total_bytes: number
        }[]
      }
      anonymize_user_audit_logs: { Args: { p_user_id: string }; Returns: Json }
      apply_stripe_subscription_sync: {
        Args: {
          p_claim_token: string
          p_fence: number
          p_snapshot: Json
          p_subscription_id: string
        }
        Returns: boolean
      }
      approve_join_request: {
        Args: { p_request_id: string; p_role?: string }
        Returns: string
      }
      auth_email_registered: { Args: { p_email: string }; Returns: boolean }
      change_membership_role: {
        Args: { p_membership_id: string; p_new_role: string }
        Returns: undefined
      }
      claim_admin_refund_uninvoiced: {
        Args: {
          p_admin_user_id: string
          p_operator_tenant_id: string
          p_payment_id: string
          p_reason: string
          p_tenant_id: string
        }
        Returns: string
      }
      claim_ksef_nip_ownership: {
        Args: { p_tenant_id: string }
        Returns: string
      }
      claim_ksef_send: {
        Args: {
          p_invoice_id: string
          p_lease_seconds: number
          p_owner: string
          p_tenant_id: string
        }
        Returns: string
      }
      claim_stripe_checkout_attempt: {
        Args: {
          p_customer_id: string
          p_plan: string
          p_price_id: string
          p_tenant_id: string
        }
        Returns: Json
      }
      claim_stripe_customer_attempt: {
        Args: { p_tenant_id: string }
        Returns: Json
      }
      claim_stripe_subscription_sync: {
        Args: { p_subscription_id: string }
        Returns: {
          claim_token: string
          claimed: boolean
          fence: number
        }[]
      }
      claim_stripe_webhook_event: {
        Args: { p_event_id: string; p_event_type: string; p_payload: Json }
        Returns: Json
      }
      cleanup_expired_validation_cache: { Args: never; Returns: number }
      cleanup_old_audit_logs: {
        Args: { p_retention_months?: number }
        Returns: Json
      }
      create_billing_vat_invoice: {
        Args: {
          p_customer_tenant_id: string
          p_invoice: Json
          p_operator_tenant_id: string
          p_payment_id: string
          p_stripe_invoice_id: string
        }
        Returns: {
          created: boolean
          internal_number: string
          invoice_id: string
        }[]
      }
      create_organization_with_owner: {
        Args: { p_address_json: Json; p_name: string; p_nip: string }
        Returns: string
      }
      days_overdue: { Args: { invoice_due_date: string }; Returns: number }
      decide_ksef_duplicate: {
        Args: {
          p_actor_user_id: string
          p_choice: string
          p_env: string
          p_invoice_id: string
          p_note?: string
          p_original_ksef_number: string
          p_original_sha256: string
          p_tenant_id: string
          p_via: string
        }
        Returns: Json
      }
      deny_join_request: { Args: { p_request_id: string }; Returns: undefined }
      enqueue_ksef_send: {
        Args: {
          p_attempt_id: string
          p_invoice_id: string
          p_tenant_id: string
        }
        Returns: {
          advance_amount: number | null
          advance_invoice_ids: string[]
          archive_storage_path: string | null
          archived_at: string | null
          bank_account_validated: boolean | null
          buyer_data: Json | null
          buyer_id_number: string | null
          buyer_id_type: Database["public"]["Enums"]["buyer_id_type_enum"]
          buyer_nip: string | null
          buyer_pesel: string | null
          buyer_vat_status_at_issue:
            | Database["public"]["Enums"]["vat_status_enum"]
            | null
          correction_reason: string | null
          correction_type:
            | Database["public"]["Enums"]["correction_type_enum"]
            | null
          created_at: string | null
          currency: string | null
          days_to_payment: number | null
          direction: string
          fa3_data: Json
          gross_total: number | null
          id: string
          internal_number: string | null
          invoice_kind: Database["public"]["Enums"]["invoice_type_enum"]
          invoice_type: string | null
          is_b2c: boolean
          issue_date: string
          ksef_accepted_at: string | null
          ksef_environment: string | null
          ksef_number: string | null
          ksef_send_owner: string | null
          ksef_status: string | null
          last_attempt_at: string | null
          last_error: string | null
          last_error_code: string | null
          last_error_field: string | null
          last_error_suggestion: string | null
          net_total: number | null
          notes: string | null
          offline_idempotency_key: string | null
          offline_qr_certyfikat: string | null
          offline_qr_offline: string | null
          origin: string
          paid_amount: number
          paid_at: string | null
          parent_invoice_id: string | null
          payment_data: Json | null
          payment_due_date: string | null
          payment_status: Database["public"]["Enums"]["payment_status_enum"]
          pdf_generated_at: string | null
          pdf_storage_path: string | null
          recurring_invoice_id: string | null
          recurring_period: string | null
          reminders_paused: boolean
          reminders_paused_reason: string | null
          sale_date: string | null
          scheduled_deletion_at: string | null
          seller_data: Json | null
          seller_nip: string | null
          special_data: Json | null
          stripe_invoice_id: string | null
          submission_attempts: number
          submitted_to_ksef_at: string | null
          tenant_id: string
          updated_at: string | null
          validation_warnings: string[] | null
          vat_total: number | null
          xml_generated_at: string | null
          xml_storage_path: string | null
        }
        SetofOptions: {
          from: "*"
          to: "invoices"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      finalize_ksef_certificate_claim: {
        Args: {
          p_actor_user_id: string
          p_certificate_expiry: string
          p_encrypted_credentials: string
          p_environment: string
          p_expected_nip: string
          p_tenant_id: string
        }
        Returns: string
      }
      finalize_stripe_webhook_event: {
        Args: {
          p_claim_token: string
          p_error_code?: string
          p_event_id: string
          p_status: string
        }
        Returns: boolean
      }
      flo_record_usage: {
        Args: {
          p_cost_usd: number
          p_day: string
          p_input_tokens: number
          p_output_tokens: number
          p_tenant_id: string
        }
        Returns: undefined
      }
      gdpr_user_deletion_blockers: {
        Args: { p_user_id: string }
        Returns: string[]
      }
      get_current_tenant_id: { Args: never; Returns: string }
      has_org_role: {
        Args: { p_org: string; p_role: string }
        Returns: boolean
      }
      hold_stripe_checkout_attempt: {
        Args: {
          p_attempt_id: string
          p_expected_status: string
          p_new_status: string
        }
        Returns: boolean
      }
      hold_stripe_customer_attempt: {
        Args: {
          p_attempt_id: string
          p_customer_id?: string
          p_tenant_id: string
        }
        Returns: boolean
      }
      hook_before_user_created: { Args: { event: Json }; Returns: Json }
      increment_export_file_download: {
        Args: { p_file_id: string; p_user_id: string }
        Returns: undefined
      }
      increment_packages_sent: {
        Args: { p_tenant_id: string }
        Returns: undefined
      }
      increment_push_failed_count: {
        Args: { sub_id: string }
        Returns: undefined
      }
      is_member_of: { Args: { p_org: string }; Returns: boolean }
      is_nip_ksef_claimed: {
        Args: { p_nip: string; p_tenant_id: string }
        Returns: boolean
      }
      ksef_duplicate_check_allows: {
        Args: { p_check: Json; p_choice: string }
        Returns: boolean
      }
      ksef_duplicate_decision_blocker: {
        Args: { p_invoice_id: string; p_tenant_id: string }
        Returns: string
      }
      ksef_error_class: { Args: { p_code: string }; Returns: string }
      ksef_has_contact_evidence: {
        Args: { p_invoice_id: string; p_tenant_id: string }
        Returns: boolean
      }
      ksef_lifecycle_violations: {
        Args: never
        Returns: {
          detail: Json
          invariant: string
          invoice_id: string
          tenant_id: string
        }[]
      }
      ksef_send_audit: {
        Args: {
          p_action: string
          p_actor_user_id: string
          p_details: Json
          p_invoice_id: string
          p_tenant_id: string
        }
        Returns: undefined
      }
      list_public_tables: {
        Args: never
        Returns: {
          table_name: string
        }[]
      }
      prune_stripe_webhook_payloads: {
        Args: { p_retention_days?: number }
        Returns: number
      }
      record_stripe_checkout_session: {
        Args: {
          p_attempt_id: string
          p_expires_at: string
          p_session_id: string
        }
        Returns: boolean
      }
      record_stripe_customer_attempt: {
        Args: {
          p_attempt_id: string
          p_customer_id: string
          p_tenant_id: string
        }
        Returns: boolean
      }
      record_stripe_financial_case: {
        Args: {
          p_amount_cents: number
          p_charge_id: string
          p_currency: string
          p_event_id: string
          p_kind: string
          p_payment_intent_id: string
          p_reference_invalid: boolean
          p_stripe_object_id: string
          p_stripe_status: string
        }
        Returns: string
      }
      record_verified_uncertain_checkout_session: {
        Args: {
          p_attempt_id: string
          p_customer_id: string
          p_expires_at: string
          p_plan: string
          p_session_id: string
          p_tenant_id: string
        }
        Returns: boolean
      }
      refresh_dashboard_materialized_views: { Args: never; Returns: Json }
      release_ksef_enqueue: {
        Args: { p_invoice_id: string; p_reason: string; p_tenant_id: string }
        Returns: boolean
      }
      release_stripe_subscription_sync: {
        Args: {
          p_claim_token: string
          p_fence: number
          p_subscription_id: string
        }
        Returns: boolean
      }
      requeue_ksef_send: {
        Args: {
          p_actor_user_id: string
          p_attempt_id: string
          p_invoice_id: string
          p_reconcile_only?: boolean
          p_tenant_id: string
        }
        Returns: {
          advance_amount: number | null
          advance_invoice_ids: string[]
          archive_storage_path: string | null
          archived_at: string | null
          bank_account_validated: boolean | null
          buyer_data: Json | null
          buyer_id_number: string | null
          buyer_id_type: Database["public"]["Enums"]["buyer_id_type_enum"]
          buyer_nip: string | null
          buyer_pesel: string | null
          buyer_vat_status_at_issue:
            | Database["public"]["Enums"]["vat_status_enum"]
            | null
          correction_reason: string | null
          correction_type:
            | Database["public"]["Enums"]["correction_type_enum"]
            | null
          created_at: string | null
          currency: string | null
          days_to_payment: number | null
          direction: string
          fa3_data: Json
          gross_total: number | null
          id: string
          internal_number: string | null
          invoice_kind: Database["public"]["Enums"]["invoice_type_enum"]
          invoice_type: string | null
          is_b2c: boolean
          issue_date: string
          ksef_accepted_at: string | null
          ksef_environment: string | null
          ksef_number: string | null
          ksef_send_owner: string | null
          ksef_status: string | null
          last_attempt_at: string | null
          last_error: string | null
          last_error_code: string | null
          last_error_field: string | null
          last_error_suggestion: string | null
          net_total: number | null
          notes: string | null
          offline_idempotency_key: string | null
          offline_qr_certyfikat: string | null
          offline_qr_offline: string | null
          origin: string
          paid_amount: number
          paid_at: string | null
          parent_invoice_id: string | null
          payment_data: Json | null
          payment_due_date: string | null
          payment_status: Database["public"]["Enums"]["payment_status_enum"]
          pdf_generated_at: string | null
          pdf_storage_path: string | null
          recurring_invoice_id: string | null
          recurring_period: string | null
          reminders_paused: boolean
          reminders_paused_reason: string | null
          sale_date: string | null
          scheduled_deletion_at: string | null
          seller_data: Json | null
          seller_nip: string | null
          special_data: Json | null
          stripe_invoice_id: string | null
          submission_attempts: number
          submitted_to_ksef_at: string | null
          tenant_id: string
          updated_at: string | null
          validation_warnings: string[] | null
          vat_total: number | null
          xml_generated_at: string | null
          xml_storage_path: string | null
        }
        SetofOptions: {
          from: "*"
          to: "invoices"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      reset_ksef_send: {
        Args: {
          p_actor_user_id: string
          p_invoice_id: string
          p_tenant_id: string
        }
        Returns: {
          advance_amount: number | null
          advance_invoice_ids: string[]
          archive_storage_path: string | null
          archived_at: string | null
          bank_account_validated: boolean | null
          buyer_data: Json | null
          buyer_id_number: string | null
          buyer_id_type: Database["public"]["Enums"]["buyer_id_type_enum"]
          buyer_nip: string | null
          buyer_pesel: string | null
          buyer_vat_status_at_issue:
            | Database["public"]["Enums"]["vat_status_enum"]
            | null
          correction_reason: string | null
          correction_type:
            | Database["public"]["Enums"]["correction_type_enum"]
            | null
          created_at: string | null
          currency: string | null
          days_to_payment: number | null
          direction: string
          fa3_data: Json
          gross_total: number | null
          id: string
          internal_number: string | null
          invoice_kind: Database["public"]["Enums"]["invoice_type_enum"]
          invoice_type: string | null
          is_b2c: boolean
          issue_date: string
          ksef_accepted_at: string | null
          ksef_environment: string | null
          ksef_number: string | null
          ksef_send_owner: string | null
          ksef_status: string | null
          last_attempt_at: string | null
          last_error: string | null
          last_error_code: string | null
          last_error_field: string | null
          last_error_suggestion: string | null
          net_total: number | null
          notes: string | null
          offline_idempotency_key: string | null
          offline_qr_certyfikat: string | null
          offline_qr_offline: string | null
          origin: string
          paid_amount: number
          paid_at: string | null
          parent_invoice_id: string | null
          payment_data: Json | null
          payment_due_date: string | null
          payment_status: Database["public"]["Enums"]["payment_status_enum"]
          pdf_generated_at: string | null
          pdf_storage_path: string | null
          recurring_invoice_id: string | null
          recurring_period: string | null
          reminders_paused: boolean
          reminders_paused_reason: string | null
          sale_date: string | null
          scheduled_deletion_at: string | null
          seller_data: Json | null
          seller_nip: string | null
          special_data: Json | null
          stripe_invoice_id: string | null
          submission_attempts: number
          submitted_to_ksef_at: string | null
          tenant_id: string
          updated_at: string | null
          validation_warnings: string[] | null
          vat_total: number | null
          xml_generated_at: string | null
          xml_storage_path: string | null
        }
        SetofOptions: {
          from: "*"
          to: "invoices"
          isOneToOne: true
          isSetofReturn: false
        }
      }
      retire_completed_stripe_checkout_attempt: {
        Args: {
          p_attempt_id: string
          p_session_id: string
          p_subscription_id: string
        }
        Returns: boolean
      }
      review_ksef_expense: {
        Args: {
          p_actor_user_id: string
          p_expected_updated_at: string
          p_expense_id: string
          p_patch: Json
          p_tenant_id: string
        }
        Returns: string
      }
      review_stripe_financial_case: {
        Args: {
          p_evidence_reference: string
          p_expected_candidate_count: number
          p_expected_candidate_payment_id: string
          p_expected_last_event_id: string
          p_expected_stripe_status: string
          p_reason: string
          p_reviewer_user_id: string
          p_stripe_object_id: string
        }
        Returns: string
      }
      revoke_membership: {
        Args: { p_membership_id: string }
        Returns: undefined
      }
      set_invoice_reminders_paused: {
        Args: { p_invoice_id: string; p_paused: boolean; p_reason?: string }
        Returns: boolean
      }
      settle_admin_refund_case: {
        Args: { p_payment_id: string; p_stripe_refund_id: string }
        Returns: string
      }
      settle_stripe_checkout_session: {
        Args: {
          p_attempt_id: string
          p_new_status: string
          p_session_id: string
        }
        Returns: boolean
      }
      shares_active_org_with: { Args: { p_user: string }; Returns: boolean }
      stripe_lock_financial_refs: {
        Args: {
          p_charge_id: string
          p_payment_intent_id: string
          p_try: boolean
        }
        Returns: boolean
      }
      stripe_payment_has_financial_hold: {
        Args: { p_payment_id: string }
        Returns: boolean
      }
    }
    Enums: {
      backup_kind: "daily" | "weekly" | "manual"
      backup_status: "running" | "success" | "failed"
      billing_notification_kind_enum:
        | "trial_14d"
        | "trial_7d"
        | "trial_3d"
        | "trial_1d"
        | "payment_failed"
        | "refund_issued"
      buyer_id_type_enum: "nip" | "pesel" | "id_card" | "passport" | "no_id"
      categorization_method:
        | "rule_nip"
        | "rule_keyword"
        | "ml_heuristic"
        | "ai_claude"
        | "manual"
        | "learned"
      correction_type_enum: "before_after" | "amount_change" | "cancellation"
      email_bounce_type_enum: "hard" | "soft" | "complaint" | "delivery_delay"
      email_category_enum: "transactional" | "product_updates" | "marketing"
      expense_source: "ocr_photo" | "ksef_inbox" | "manual" | "import"
      export_format_enum:
        | "jpk_fa"
        | "kpir_excel"
        | "comarch_optima"
        | "insert_subiekt"
        | "symfonia"
        | "wapro"
        | "csv_universal"
        | "jpk_v7m"
      export_status_enum:
        | "pending"
        | "generating"
        | "completed"
        | "failed"
        | "expired"
      export_trigger_enum:
        | "manual"
        | "co_pilot_monthly"
        | "accountant_portal"
        | "api"
      gdpr_deletion_status:
        | "pending"
        | "canceled"
        | "executed"
        | "failed"
        | "processing"
      invoice_type_enum: "regular" | "correction" | "advance" | "final"
      kpir_column:
        | "col_7"
        | "col_8"
        | "col_10"
        | "col_11"
        | "col_12"
        | "col_13"
        | "col_15"
        | "col_16"
      ocr_status: "pending" | "processing" | "completed" | "failed"
      offline_queue_status_enum:
        | "queued"
        | "sending"
        | "sent"
        | "failed"
        | "expired"
      payment_method_enum:
        | "bank_transfer"
        | "card"
        | "cash"
        | "compensation"
        | "other"
      payment_status_enum: "unpaid" | "partial" | "paid" | "overdue"
      reminder_channel_enum: "email" | "sms" | "both"
      reminder_stage_enum: "stage_1" | "stage_2" | "stage_3" | "stage_4"
      reminder_status_enum: "pending" | "sent" | "failed" | "cancelled"
      stripe_payment_status_enum:
        | "succeeded"
        | "failed"
        | "pending"
        | "refunded"
        | "partially_refunded"
      subscription_plan_enum: "monthly" | "annual"
      subscription_status_enum:
        | "trialing"
        | "active"
        | "past_due"
        | "canceled"
        | "incomplete"
        | "incomplete_expired"
        | "unpaid"
        | "paused"
      support_category:
        | "onboarding"
        | "ksef"
        | "invoicing"
        | "ocr_kpir"
        | "billing"
        | "team"
        | "security"
        | "other"
      support_conversation_status: "open" | "escalated" | "resolved" | "closed"
      support_message_role: "user" | "assistant" | "system"
      upo_status_enum: "pending" | "downloaded" | "failed" | "archived"
      validation_source_enum: "whitelist" | "vies" | "manual"
      vat_status_enum: "active" | "exempt" | "inactive" | "unknown" | "pending"
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
  graphql_public: {
    Enums: {},
  },
  public: {
    Enums: {
      backup_kind: ["daily", "weekly", "manual"],
      backup_status: ["running", "success", "failed"],
      billing_notification_kind_enum: [
        "trial_14d",
        "trial_7d",
        "trial_3d",
        "trial_1d",
        "payment_failed",
        "refund_issued",
      ],
      buyer_id_type_enum: ["nip", "pesel", "id_card", "passport", "no_id"],
      categorization_method: [
        "rule_nip",
        "rule_keyword",
        "ml_heuristic",
        "ai_claude",
        "manual",
        "learned",
      ],
      correction_type_enum: ["before_after", "amount_change", "cancellation"],
      email_bounce_type_enum: ["hard", "soft", "complaint", "delivery_delay"],
      email_category_enum: ["transactional", "product_updates", "marketing"],
      expense_source: ["ocr_photo", "ksef_inbox", "manual", "import"],
      export_format_enum: [
        "jpk_fa",
        "kpir_excel",
        "comarch_optima",
        "insert_subiekt",
        "symfonia",
        "wapro",
        "csv_universal",
        "jpk_v7m",
      ],
      export_status_enum: [
        "pending",
        "generating",
        "completed",
        "failed",
        "expired",
      ],
      export_trigger_enum: [
        "manual",
        "co_pilot_monthly",
        "accountant_portal",
        "api",
      ],
      gdpr_deletion_status: [
        "pending",
        "canceled",
        "executed",
        "failed",
        "processing",
      ],
      invoice_type_enum: ["regular", "correction", "advance", "final"],
      kpir_column: [
        "col_7",
        "col_8",
        "col_10",
        "col_11",
        "col_12",
        "col_13",
        "col_15",
        "col_16",
      ],
      ocr_status: ["pending", "processing", "completed", "failed"],
      offline_queue_status_enum: [
        "queued",
        "sending",
        "sent",
        "failed",
        "expired",
      ],
      payment_method_enum: [
        "bank_transfer",
        "card",
        "cash",
        "compensation",
        "other",
      ],
      payment_status_enum: ["unpaid", "partial", "paid", "overdue"],
      reminder_channel_enum: ["email", "sms", "both"],
      reminder_stage_enum: ["stage_1", "stage_2", "stage_3", "stage_4"],
      reminder_status_enum: ["pending", "sent", "failed", "cancelled"],
      stripe_payment_status_enum: [
        "succeeded",
        "failed",
        "pending",
        "refunded",
        "partially_refunded",
      ],
      subscription_plan_enum: ["monthly", "annual"],
      subscription_status_enum: [
        "trialing",
        "active",
        "past_due",
        "canceled",
        "incomplete",
        "incomplete_expired",
        "unpaid",
        "paused",
      ],
      support_category: [
        "onboarding",
        "ksef",
        "invoicing",
        "ocr_kpir",
        "billing",
        "team",
        "security",
        "other",
      ],
      support_conversation_status: ["open", "escalated", "resolved", "closed"],
      support_message_role: ["user", "assistant", "system"],
      upo_status_enum: ["pending", "downloaded", "failed", "archived"],
      validation_source_enum: ["whitelist", "vies", "manual"],
      vat_status_enum: ["active", "exempt", "inactive", "unknown", "pending"],
    },
  },
} as const
