use anchor_lang::prelude::*;

// Devnet program id (keypair: target/deploy/agentboard-keypair.json,
// synced with `anchor keys sync`).
declare_id!("2iPfRiccKppYcNzZb15b68ydZdjDh2oDM5HUH5BpNHRz");

pub const MAX_NAME_LEN: usize = 32;
pub const MAX_URI_LEN: usize = 128;
pub const SECONDS_PER_DAY: i64 = 86_400;

#[program]
pub mod agentboard {
    use super::*;

    /// Register a new agent profile for the signer. One profile per wallet
    /// (the profile PDA is derived from the authority, so a second
    /// registration for the same wallet fails at account init).
    pub fn register_agent(
        ctx: Context<RegisterAgent>,
        name: String,
        metadata_uri: String,
    ) -> Result<()> {
        require!(!name.is_empty(), AgentBoardError::EmptyName);
        require!(name.len() <= MAX_NAME_LEN, AgentBoardError::NameTooLong);
        require!(
            metadata_uri.len() <= MAX_URI_LEN,
            AgentBoardError::UriTooLong
        );

        let profile = &mut ctx.accounts.profile;
        profile.authority = ctx.accounts.authority.key();
        profile.name = name.clone();
        profile.metadata_uri = metadata_uri.clone();
        profile.checkin_streak = 0;
        profile.best_streak = 0;
        profile.total_checkins = 0;
        // Sentinel: -1 means "never checked in". Real UTC day numbers from
        // the Clock sysvar are always >= 0.
        profile.last_checkin_day = -1;
        profile.bump = ctx.bumps.profile;

        let stats = &mut ctx.accounts.stats;
        stats.bump = ctx.bumps.stats;
        stats.total_agents = stats
            .total_agents
            .checked_add(1)
            .ok_or(AgentBoardError::Overflow)?;

        emit!(AgentRegistered {
            authority: profile.authority,
            name,
            metadata_uri,
        });

        Ok(())
    }

    /// Daily check-in. At most one counted check-in per UTC day (day number
    /// = Clock unix_timestamp / 86_400, mirroring the BSC guestbook's
    /// `block.timestamp / 1 days`). A check-in on the day after the previous
    /// one extends the streak; a gap of one or more days restarts it at 1.
    /// A repeat call on the same UTC day is rejected, so a day can never be
    /// counted twice.
    pub fn check_in(ctx: Context<CheckIn>) -> Result<()> {
        let today = Clock::get()?.unix_timestamp / SECONDS_PER_DAY;
        let profile = &mut ctx.accounts.profile;

        require!(
            profile.last_checkin_day != today,
            AgentBoardError::AlreadyCheckedInToday
        );

        let stats = &mut ctx.accounts.stats;
        if profile.total_checkins == 0 {
            // First ever counted check-in from this agent.
            stats.unique_agents = stats
                .unique_agents
                .checked_add(1)
                .ok_or(AgentBoardError::Overflow)?;
        }

        if profile.last_checkin_day == today - 1 {
            profile.checkin_streak = profile
                .checkin_streak
                .checked_add(1)
                .ok_or(AgentBoardError::Overflow)?;
        } else {
            profile.checkin_streak = 1;
        }
        if profile.checkin_streak > profile.best_streak {
            profile.best_streak = profile.checkin_streak;
        }

        profile.last_checkin_day = today;
        profile.total_checkins = profile
            .total_checkins
            .checked_add(1)
            .ok_or(AgentBoardError::Overflow)?;

        stats.total_checkins = stats
            .total_checkins
            .checked_add(1)
            .ok_or(AgentBoardError::Overflow)?;

        emit!(CheckedIn {
            authority: profile.authority,
            day: today,
            streak: profile.checkin_streak,
            total_checkins: profile.total_checkins,
        });

        Ok(())
    }

    /// Update the caller's own agent name / metadata URI.
    pub fn update_profile(
        ctx: Context<UpdateProfile>,
        name: String,
        metadata_uri: String,
    ) -> Result<()> {
        require!(!name.is_empty(), AgentBoardError::EmptyName);
        require!(name.len() <= MAX_NAME_LEN, AgentBoardError::NameTooLong);
        require!(
            metadata_uri.len() <= MAX_URI_LEN,
            AgentBoardError::UriTooLong
        );

        let profile = &mut ctx.accounts.profile;
        profile.name = name.clone();
        profile.metadata_uri = metadata_uri.clone();

        emit!(ProfileUpdated {
            authority: profile.authority,
            name,
            metadata_uri,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct RegisterAgent<'info> {
    #[account(
        init,
        payer = authority,
        space = AgentProfile::SPACE,
        seeds = [b"agent", authority.key().as_ref()],
        bump
    )]
    pub profile: Account<'info, AgentProfile>,

    #[account(
        init_if_needed,
        payer = authority,
        space = BoardStats::SPACE,
        seeds = [b"stats"],
        bump
    )]
    pub stats: Account<'info, BoardStats>,

    #[account(mut)]
    pub authority: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CheckIn<'info> {
    #[account(
        mut,
        seeds = [b"agent", authority.key().as_ref()],
        bump = profile.bump,
        has_one = authority
    )]
    pub profile: Account<'info, AgentProfile>,

    #[account(mut, seeds = [b"stats"], bump = stats.bump)]
    pub stats: Account<'info, BoardStats>,

    pub authority: Signer<'info>,
}

#[derive(Accounts)]
pub struct UpdateProfile<'info> {
    #[account(
        mut,
        seeds = [b"agent", authority.key().as_ref()],
        bump = profile.bump,
        has_one = authority
    )]
    pub profile: Account<'info, AgentProfile>,

    pub authority: Signer<'info>,
}

#[account]
pub struct AgentProfile {
    pub authority: Pubkey,
    pub name: String,
    pub metadata_uri: String,
    pub checkin_streak: u32,
    pub best_streak: u32,
    pub total_checkins: u32,
    /// UTC day number (unix_timestamp / 86_400) of the most recent counted
    /// check-in; -1 means the agent has never checked in.
    pub last_checkin_day: i64,
    pub bump: u8,
}

impl AgentProfile {
    pub const SPACE: usize = 8  // discriminator
        + 32                    // authority
        + 4 + MAX_NAME_LEN      // name
        + 4 + MAX_URI_LEN       // metadata_uri
        + 4                     // checkin_streak
        + 4                     // best_streak
        + 4                     // total_checkins
        + 8                     // last_checkin_day
        + 1; // bump
}

#[account]
pub struct BoardStats {
    pub total_agents: u64,
    pub total_checkins: u64,
    pub unique_agents: u64,
    pub bump: u8,
}

impl BoardStats {
    pub const SPACE: usize = 8 + 8 + 8 + 8 + 1;
}

#[event]
pub struct AgentRegistered {
    pub authority: Pubkey,
    pub name: String,
    pub metadata_uri: String,
}

#[event]
pub struct CheckedIn {
    pub authority: Pubkey,
    pub day: i64,
    pub streak: u32,
    pub total_checkins: u32,
}

#[event]
pub struct ProfileUpdated {
    pub authority: Pubkey,
    pub name: String,
    pub metadata_uri: String,
}

#[error_code]
pub enum AgentBoardError {
    #[msg("Name must not be empty")]
    EmptyName,
    #[msg("Name exceeds 32 bytes")]
    NameTooLong,
    #[msg("Metadata URI exceeds 128 bytes")]
    UriTooLong,
    #[msg("This agent has already checked in today")]
    AlreadyCheckedInToday,
    #[msg("Counter overflow")]
    Overflow,
}
